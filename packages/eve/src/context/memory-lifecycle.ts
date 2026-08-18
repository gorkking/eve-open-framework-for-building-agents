import type { ModelMessage } from "ai";

import { buildCallbackContext } from "#context/build-callback-context.js";
import {
  runWithDefaultMemoryNamespaceContext,
  type DefaultMemoryNamespaceContext,
} from "#context/default-memory-namespace-context.js";
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
import { resolveMemoryTurnTools } from "#context/memory-tool-lifecycle.js";
import {
  anchorUnanchoredVisibleMemoryProjections,
  clearMemoryProjectionAnchors,
  getActiveMemoryTurn,
  getMemoryState,
  getPendingMemoryCompaction,
  projectMemoryMessages,
  reanchorVisibleMemoryProjections,
  releaseMemoryToolOrigins,
  setActiveMemoryTurn,
  setPendingMemoryCompaction,
  updateMemoryProjection,
  type DurableMemorySlotLock,
  type DurableMemoryTurnState,
} from "#harness/memory-state.js";
import type { HarnessSession } from "#harness/types.js";
import { createLogger } from "#internal/logging.js";
import type {
  MemoryNamespaceDefinition,
  MemoryRecallContext,
  MemorySaveContext,
  MemoryScope,
  MemoryScopeDefinition,
  MemoryTurnContext,
} from "#public/memory/index.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";

const log = createLogger("memory");
const MEMORY_SCOPE_DOMAIN = "eve-memory-scope-v1";

export type MemoryDefaultNamespaceContext = Omit<DefaultMemoryNamespaceContext, "slot">;

export { MemoryOperationError };
export {
  buildMemoryTools,
  getMemoryToolOriginCallIds,
  recordMemoryToolOrigins,
  releaseMemoryToolOrigins,
  resolveMemoryApprovalTools,
  restoreMemoryToolTurn,
} from "#context/memory-tool-lifecycle.js";

/** Resolves and locks every scope, anchors visible projections, then recalls the turn. */
export async function startMemoryTurn(input: {
  readonly abortSignal?: AbortSignal;
  readonly defaultNamespaceContext: MemoryDefaultNamespaceContext;
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
    defaultNamespaceContext: input.defaultNamespaceContext,
    memories: input.memories,
  });
  const activeTurn: DurableMemoryTurnState = {
    principalIdentity: principalIdentity(callbackSession.auth.current),
    session: callbackSession,
    slots,
    toolMetadata: [],
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

  return await resolveMemoryTurnTools({
    memories: input.memories,
    messages: [...input.messages, ...input.turn.input],
    session,
  });
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
  readonly defaultNamespaceContext: MemoryDefaultNamespaceContext;
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
        defaultNamespaceContext: input.defaultNamespaceContext,
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
        origin.turnState.session.id === active.session.id &&
        origin.turnState.turn.turnId === active.turn.turnId &&
        origin.turnState.turn.sequence === active.turn.sequence,
    )
    .map((origin) => origin.callId);
  const session = releaseMemoryToolOrigins({ callIds: originCallIds, session: input.session });
  return setActiveMemoryTurn(session, null);
}

/** Clears prompt anchors while preserving provider projections for the next recall. */
export function clearMemoryAnchors(session: HarnessSession): HarnessSession {
  return clearMemoryProjectionAnchors(session);
}

async function resolveMemorySlots(input: {
  readonly defaultNamespaceContext: MemoryDefaultNamespaceContext;
  readonly memories: readonly ResolvedMemoryDefinition[];
}): Promise<readonly DurableMemorySlotLock[]> {
  const slots: DurableMemorySlotLock[] = [];
  for (const memory of sortMemories(input.memories)) {
    const value = await resolveScope(memory.slot, memory.scope);
    if (value === null) {
      slots.push({ scope: null, slot: memory.slot, visibility: memory.visibility });
      continue;
    }
    const namespace = await resolveNamespace(
      memory.slot,
      memory.namespace,
      input.defaultNamespaceContext,
    );
    if (namespace === null) {
      slots.push({ scope: null, slot: memory.slot, visibility: memory.visibility });
      continue;
    }
    slots.push({
      scope: createScope(namespace, value),
      slot: memory.slot,
      visibility: memory.visibility,
    });
  }
  return slots;
}

async function resolveNamespace(
  slot: string,
  definition: MemoryNamespaceDefinition,
  context: MemoryDefaultNamespaceContext,
): Promise<string | null> {
  let namespace: unknown;
  try {
    namespace = await runWithDefaultMemoryNamespaceContext(
      { ...context, slot } satisfies DefaultMemoryNamespaceContext,
      async () => await resolveDefinition(definition),
    );
  } catch (cause) {
    throw new Error(`Memory namespace "${slot}" failed to resolve.`, { cause });
  }
  if (namespace === null) return null;
  validateAddressValue("namespace", slot, namespace);
  return namespace;
}

async function resolveScope(
  slot: string,
  definition: MemoryScopeDefinition,
): Promise<string | null> {
  let scope: unknown;
  try {
    scope = await resolveDefinition(definition);
  } catch (cause) {
    throw new Error(`Memory scope "${slot}" failed to resolve.`, { cause });
  }
  if (scope === null) return null;
  validateAddressValue("scope", slot, scope);
  return scope;
}

async function resolveDefinition<T>(
  definition: T | Promise<T> | (() => T | Promise<T>),
): Promise<T> {
  return typeof definition === "function"
    ? await (definition as () => T | Promise<T>)()
    : await definition;
}

function validateAddressValue(
  kind: "namespace" | "scope",
  slot: string,
  value: unknown,
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Memory ${kind} "${slot}" must resolve to a non-empty string.`);
  }
}

function createScope(namespace: string, value: string): MemoryScope {
  const digest = createMemoryDigest([MEMORY_SCOPE_DOMAIN, namespace, value]);
  return { key: `mem_${digest}`, namespace, value };
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
