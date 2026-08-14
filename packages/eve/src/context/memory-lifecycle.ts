import type { ModelMessage } from "ai";

import { buildCallbackContext } from "#context/build-callback-context.js";
import {
  captureCallbackSession,
  cloneTurn,
  createMemoryDigest,
  createMemoryOperationId,
  createOperationContext,
  MemoryOperationError,
  principalIdentity,
  requireMemory,
  resolveAbortSignal,
} from "#context/memory-operation.js";
import {
  anchorUnanchoredVisibleMemoryProjections,
  clearMemoryProjectionAnchors,
  getActiveMemoryTurn,
  getMemoryState,
  getPendingMemoryCompaction,
  projectMemoryMessages,
  reanchorVisibleMemoryProjections,
  releaseMemoryToolOrigins,
  setActiveMemoryToolOperations,
  setActiveMemoryTurn,
  setPendingMemoryCompaction,
  updateMemoryProjection,
  type DurableMemorySlotLock,
  type DurableMemoryTurnState,
} from "#harness/memory-state.js";
import type { HarnessSession } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type {
  MemoryRecallContext,
  MemorySaveContext,
  MemoryScope,
  MemoryScopeContext,
  MemoryTurnContext,
} from "#public/memory/index.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";

const log = createLogger("memory");
const MEMORY_SCOPE_DOMAIN = "eve-memory-scope-v1";

export interface MemoryRuntimeIdentity {
  readonly applicationId: string;
  readonly environment: string;
  readonly nodeId: string;
}

export { MemoryOperationError };
export {
  getMemoryToolOriginCallIds,
  recordMemoryToolOrigins,
  releaseMemoryToolOrigins,
  resolveMemoryApprovalTools,
  resolveMemoryTools,
  restoreMemoryToolTurn,
} from "#context/memory-tool-lifecycle.js";

/** Resolves and locks every scope, anchors visible projections, then recalls the turn. */
export async function startMemoryTurn(input: {
  readonly abortSignal?: AbortSignal;
  readonly identity: MemoryRuntimeIdentity;
  readonly memories: readonly ResolvedMemoryDefinition[];
  /** Prior durable history. The normalized turn input is carried separately in `turn.input`. */
  readonly messages: readonly ModelMessage[];
  readonly projectionAnchorIndex: number;
  readonly session: HarnessSession;
  readonly turn: MemoryTurnContext;
}): Promise<HarnessSession> {
  if (input.memories.length === 0) return input.session;
  const existing = getActiveMemoryTurn(input.session);
  if (
    existing?.turn.turnId === input.turn.turnId &&
    existing.turn.sequence === input.turn.sequence
  ) {
    return input.session;
  }

  const abortSignal = resolveAbortSignal(input.abortSignal);
  const callback = buildCallbackContext();
  const callbackSession = captureCallbackSession(callback, input.turn);
  const slots = await resolveMemorySlots({
    abortSignal,
    callback,
    identity: input.identity,
    memories: input.memories,
  });
  const activeTurn: DurableMemoryTurnState = {
    nextStepIndex: 0,
    principalIdentity: principalIdentity(callbackSession.auth.current),
    session: callbackSession,
    slots,
    turn: cloneTurn(input.turn),
  };

  let session = setActiveMemoryTurn(input.session, activeTurn);
  session = anchorUnanchoredVisibleMemoryProjections({
    anchorIndex: input.projectionAnchorIndex,
    session,
    slots,
  });

  for (const lock of slots) {
    if (lock.scope === null) continue;
    const memory = requireMemory(input.memories, lock.slot);
    const operationId = createTurnOperationId({
      phase: "turn.started",
      scope: lock.scope,
      sessionId: callbackSession.id,
      slot: lock.slot,
      turnId: input.turn.turnId,
    });
    const context: MemoryRecallContext = {
      ...createOperationContext({
        abortSignal,
        callbackSession,
        messages: input.messages,
        operationId,
        scope: lock.scope,
        session,
        slot: lock.slot,
      }),
      phase: "turn.started",
      turn: cloneTurn(input.turn),
    };

    try {
      const result = await memory.provider.recall(context);
      session = updateMemoryProjection({
        anchorIndex: input.projectionAnchorIndex,
        result,
        scope: lock.scope,
        session,
        slot: lock.slot,
      });
    } catch (cause) {
      throw new MemoryOperationError({
        cause,
        operationId,
        phase: "turn.started",
        slot: lock.slot,
      });
    }
  }

  return session;
}

/** Builds the model-only prompt view without mutating ordinary history. */
export function projectMemoryPrompt(input: {
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly messages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): ModelMessage[] {
  if (input.memories.length === 0) return [...input.messages];
  return projectMemoryMessages({ messages: input.messages, session: input.session });
}

/** Locks a standalone compaction or reuses the active turn lock, then runs pre-save. */
export async function startMemoryCompaction(input: {
  readonly abortSignal?: AbortSignal;
  readonly identity: MemoryRuntimeIdentity;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly messages: readonly ModelMessage[];
  readonly modelId: string;
  readonly session: HarnessSession;
  readonly standalone: boolean;
  readonly usageInputTokens: number | null;
}): Promise<HarnessSession> {
  if (input.memories.length === 0) return input.session;
  if (getPendingMemoryCompaction(input.session) !== null) {
    throw new Error("A memory compaction lifecycle is already active.");
  }

  const abortSignal = resolveAbortSignal(input.abortSignal);
  const active = getActiveMemoryTurn(input.session);
  if (!input.standalone && active === null) {
    throw new Error("Automatic memory compaction requires an active turn.");
  }

  const callback = buildCallbackContext();
  const standaloneSession = captureCallbackSession(callback, null);
  const slots = input.standalone
    ? await resolveMemorySlots({
        abortSignal,
        callback,
        identity: input.identity,
        memories: input.memories,
      })
    : active!.slots;
  const callbackSession = input.standalone ? standaloneSession : active!.session;
  const turn = input.standalone ? null : active!.turn;
  const ordinal = getMemoryState(input.session).nextCompactionOrdinal;
  const pending = {
    modelId: input.modelId,
    ordinal,
    session: callbackSession,
    slots,
    standalone: input.standalone,
    turn,
    usageInputTokens: input.usageInputTokens,
  } as const;
  let session = setPendingMemoryCompaction(input.session, pending, ordinal + 1);

  for (const lock of slots) {
    if (lock.scope === null) continue;
    const memory = requireMemory(input.memories, lock.slot);
    if (memory.provider.save === undefined) continue;
    const operationId = createCompactionOperationId({
      ordinal,
      phase: "compaction.requested",
      scope: lock.scope,
      sessionId: callbackSession.id,
      slot: lock.slot,
    });
    const context: MemorySaveContext = {
      ...createOperationContext({
        abortSignal,
        callbackSession,
        messages: input.messages,
        operationId,
        scope: lock.scope,
        session,
        slot: lock.slot,
      }),
      compaction: {
        modelId: input.modelId,
        usageInputTokens: input.usageInputTokens,
      },
      phase: "compaction.requested",
      turn,
    };

    try {
      await memory.provider.save(context);
    } catch (cause) {
      throw new MemoryOperationError({
        cause,
        operationId,
        phase: "compaction.requested",
        slot: lock.slot,
      });
    }
  }

  return session;
}

/** Reanchors projections against compacted history, then runs post-compaction recall. */
export async function finishMemoryCompaction(input: {
  readonly abortSignal?: AbortSignal;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly messages: readonly ModelMessage[];
  readonly projectionAnchorIndex: number;
  readonly session: HarnessSession;
}): Promise<{ readonly failure?: MemoryOperationError; readonly session: HarnessSession }> {
  if (input.memories.length === 0) return { session: input.session };
  const pending = getPendingMemoryCompaction(input.session);
  if (pending === null) {
    throw new Error("Memory compaction completion has no matching requested lifecycle.");
  }

  const abortSignal = resolveAbortSignal(input.abortSignal);
  let session = reanchorVisibleMemoryProjections({
    anchorIndex: input.projectionAnchorIndex,
    session: input.session,
    slots: pending.slots,
  });

  for (const lock of pending.slots) {
    if (lock.scope === null) continue;
    const operationId = createCompactionOperationId({
      ordinal: pending.ordinal,
      phase: "compaction.completed",
      scope: lock.scope,
      sessionId: pending.session.id,
      slot: lock.slot,
    });

    try {
      const memory = requireMemory(input.memories, lock.slot);
      const context: MemoryRecallContext = {
        ...createOperationContext({
          abortSignal,
          callbackSession: pending.session,
          messages: input.messages,
          operationId,
          scope: lock.scope,
          session,
          slot: lock.slot,
        }),
        compaction: { modelId: pending.modelId },
        phase: "compaction.completed",
        turn: pending.turn,
      };
      const result = await memory.provider.recall(context);
      session = updateMemoryProjection({
        anchorIndex: input.projectionAnchorIndex,
        result,
        scope: lock.scope,
        session,
        slot: lock.slot,
      });
    } catch (cause) {
      const failure = new MemoryOperationError({
        cause,
        operationId,
        phase: "compaction.completed",
        slot: lock.slot,
      });
      if (!pending.standalone) {
        return { failure, session: setPendingMemoryCompaction(session, null) };
      }
      logSettledFailure(failure);
    }
  }

  return { session: setPendingMemoryCompaction(session, null) };
}

/** Runs best-effort completed-turn saves in stable slot order. */
export async function saveCompletedMemoryTurn(input: {
  readonly abortSignal?: AbortSignal;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly messages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): Promise<HarnessSession> {
  const active = getActiveMemoryTurn(input.session);
  if (input.memories.length === 0 || active === null) return input.session;
  const abortSignal = resolveAbortSignal(input.abortSignal);

  for (const lock of active.slots) {
    if (lock.scope === null) continue;
    const operationId = createTurnOperationId({
      phase: "turn.completed",
      scope: lock.scope,
      sessionId: active.session.id,
      slot: lock.slot,
      turnId: active.turn.turnId,
    });

    try {
      const memory = requireMemory(input.memories, lock.slot);
      if (memory.provider.save === undefined) continue;
      const context: MemorySaveContext = {
        ...createOperationContext({
          abortSignal,
          callbackSession: active.session,
          messages: input.messages,
          operationId,
          scope: lock.scope,
          session: input.session,
          slot: lock.slot,
        }),
        phase: "turn.completed",
        turn: active.turn,
      };
      await memory.provider.save(context);
    } catch (cause) {
      logSettledFailure(
        new MemoryOperationError({
          cause,
          operationId,
          phase: "turn.completed",
          slot: lock.slot,
        }),
      );
    }
  }

  const originCallIds = Object.values(getMemoryState(input.session).toolOrigins)
    .filter(
      (origin) =>
        origin.session.id === active.session.id &&
        origin.turn.turnId === active.turn.turnId &&
        origin.turn.sequence === active.turn.sequence,
    )
    .map((origin) => origin.callId);
  const session = releaseMemoryToolOrigins({ callIds: originCallIds, session: input.session });
  return setActiveMemoryTurn(setActiveMemoryToolOperations(session, []), null);
}

/** Clears prompt anchors while preserving provider projections for the next recall. */
export function clearMemoryAnchors(session: HarnessSession): HarnessSession {
  return clearMemoryProjectionAnchors(session);
}

async function resolveMemorySlots(input: {
  readonly abortSignal: AbortSignal;
  readonly callback: SessionContext;
  readonly identity: MemoryRuntimeIdentity;
  readonly memories: readonly ResolvedMemoryDefinition[];
}): Promise<readonly DurableMemorySlotLock[]> {
  const slots: DurableMemorySlotLock[] = [];
  for (const memory of sortMemories(input.memories)) {
    let parts: readonly string[] | null;
    try {
      const scopeContext: MemoryScopeContext = {
        ...input.callback,
        abortSignal: input.abortSignal,
      };
      parts = await memory.scope(scopeContext);
      if (parts !== null) validateScopeParts(memory.slot, parts);
    } catch (cause) {
      throw new Error(`Memory scope resolver "${memory.slot}" failed.`, { cause });
    }
    slots.push({
      scope: parts === null ? null : createScope(input.identity, memory.slot, parts),
      slot: memory.slot,
      visibility: memory.visibility,
    });
  }
  return slots;
}

function createScope(
  identity: MemoryRuntimeIdentity,
  slot: string,
  parts: readonly string[],
): MemoryScope {
  const digest = createMemoryDigest([
    MEMORY_SCOPE_DOMAIN,
    identity.applicationId,
    identity.environment,
    identity.nodeId,
    slot,
    parts,
  ]);
  return { key: `mem_${digest}`, parts: [...parts] };
}

function createTurnOperationId(input: {
  readonly phase: "turn.completed" | "turn.started";
  readonly scope: MemoryScope;
  readonly sessionId: string;
  readonly slot: string;
  readonly turnId: string;
}): string {
  return createMemoryOperationId([
    input.sessionId,
    input.slot,
    input.scope.key,
    input.phase,
    input.turnId,
  ]);
}

function createCompactionOperationId(input: {
  readonly ordinal: number;
  readonly phase: "compaction.completed" | "compaction.requested";
  readonly scope: MemoryScope;
  readonly sessionId: string;
  readonly slot: string;
}): string {
  return createMemoryOperationId([
    input.sessionId,
    input.slot,
    input.scope.key,
    input.phase,
    input.ordinal,
  ]);
}

function validateScopeParts(slot: string, parts: readonly string[]): void {
  if (!Array.isArray(parts)) {
    throw new TypeError(`Memory scope "${slot}" must return an array of strings or null.`);
  }
  for (const part of parts) {
    if (typeof part !== "string" || part.length === 0) {
      throw new TypeError(`Memory scope "${slot}" returned an empty or non-string scope part.`);
    }
  }
}

function sortMemories(
  memories: readonly ResolvedMemoryDefinition[],
): readonly ResolvedMemoryDefinition[] {
  return [...memories].sort((left, right) => compareStrings(left.slot, right.slot));
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function logSettledFailure(error: MemoryOperationError): void {
  log.error("Memory provider operation failed after settlement.", {
    operationId: error.operationId,
    phase: error.phase,
    slot: error.slot,
  });
}
