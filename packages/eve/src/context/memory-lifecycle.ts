import type { ModelMessage } from "ai";

import { buildCallbackContext } from "#context/build-callback-context.js";
import { loadContext } from "#context/container.js";
import { buildResolveRequestContext } from "#context/dynamic-resolve-context.js";
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
  getActiveMemoryTurn,
  getMemoryState,
  getPendingMemoryCompaction,
  projectMemoryMessages,
  releaseMemoryToolOrigins,
  setActiveMemoryTurn,
  setPendingMemoryCompaction,
  type DurableMemorySlotLock,
  type DurableMemoryTurnState,
} from "#harness/memory-state.js";
import type { HarnessSession } from "#harness/types.js";
import { normalizeInstructionsDefinition } from "#internal/authored-definition/core.js";
import { createLogger } from "#internal/logging.js";
import type {
  MemoryCaptureContext,
  MemoryNamespaceDefinition,
  MemoryRecallContext,
  MemoryRecallResult,
  MemoryScope,
  MemoryScopeContext,
  MemoryScopeDefinition,
  MemoryTurnContext,
} from "#public/memory/index.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
import { attributeMemoryMessage } from "#shared/memory-message.js";

const log = createLogger("memory");
const MEMORY_SCOPE_DOMAIN = "eve-memory-scope-v1";

/** Deployment coordinates shared by every slot's namespace resolution. */
export interface MemoryDefaultNamespaceContext {
  readonly appRoot: string;
  readonly node: string;
}

export { MemoryOperationError };
export {
  buildMemoryTools,
  getMemoryToolOriginCallIds,
  recordMemoryToolOrigins,
  releaseMemoryToolOrigins,
  resolveMemoryApprovalTools,
  restoreMemoryToolTurn,
} from "#context/memory-tool-lifecycle.js";

/** Resolves and locks every scope, then appends turn-start recall messages. */
export async function startMemoryTurn(input: {
  readonly abortSignal?: AbortSignal;
  readonly defaultNamespaceContext: MemoryDefaultNamespaceContext;
  readonly memories: readonly ResolvedMemoryDefinition[];
  /** Prior durable history. The normalized turn input is carried separately in `turn.input`. */
  readonly messages: readonly ModelMessage[];
  readonly session: HarnessSession;
  readonly turn: MemoryTurnContext;
}): Promise<HarnessSession> {
  if (input.memories.length === 0) return input.session;
  const existing = getActiveMemoryTurn(input.session);
  if (existing?.turn.id === input.turn.id && existing.turn.sequence === input.turn.sequence) {
    return input.session;
  }

  const abortSignal = resolveAbortSignal(input.abortSignal);
  const callback = buildCallbackContext();
  const callbackSession = captureCallbackSession(callback, input.turn);
  const scopeContext = createScopeContext(abortSignal);
  const slots = await resolveMemorySlots({
    defaultNamespaceContext: input.defaultNamespaceContext,
    memories: input.memories,
    scopeContext,
  });
  const activeTurn: DurableMemoryTurnState = {
    principalIdentity: principalIdentity(callbackSession.auth.current),
    session: callbackSession,
    slots,
    toolMetadata: [],
    turn: cloneTurn(input.turn),
  };

  let session = setActiveMemoryTurn({ ...input.session, history: [...input.messages] }, activeTurn);

  for (const lock of slots) {
    if (lock.scope === null) continue;
    const memory = requireMemory(input.memories, lock.slot);
    const operationId = createTurnOperationId({
      phase: "turn.started",
      scope: lock.scope,
      sessionId: callbackSession.id,
      slot: lock.slot,
      turnId: input.turn.id,
    });
    const context: MemoryRecallContext = {
      ...createOperationContext({
        abortSignal,
        callbackSession,
        messages: input.messages,
        operationId,
        scope: lock.scope,
        slot: lock.slot,
      }),
      phase: "turn.started",
      turn: cloneTurn(input.turn),
    };

    try {
      const result = await memory.provider.recall(context);
      session = appendRecallResult({
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
    messages: [...session.history, ...input.turn.input],
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

/** Locks the scopes used to filter and process one compaction operation. */
export async function prepareMemoryCompaction(input: {
  readonly abortSignal?: AbortSignal;
  readonly defaultNamespaceContext: MemoryDefaultNamespaceContext;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly modelId: string;
  readonly session: HarnessSession;
  readonly standalone: boolean;
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
        scopeContext: createScopeContext(abortSignal),
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
    usageInputTokens: null,
  } as const;
  return setPendingMemoryCompaction(input.session, pending, ordinal + 1);
}

/** Runs pre-compaction captures after visibility and usage have been resolved. */
export async function startMemoryCompaction(input: {
  readonly abortSignal?: AbortSignal;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly messages: readonly ModelMessage[];
  readonly session: HarnessSession;
  readonly usageInputTokens: number | null;
}): Promise<HarnessSession> {
  if (input.memories.length === 0) return input.session;
  const pending = getPendingMemoryCompaction(input.session);
  if (pending === null) {
    throw new Error("Memory compaction start has no prepared lifecycle.");
  }

  const abortSignal = resolveAbortSignal(input.abortSignal);
  const session = setPendingMemoryCompaction(input.session, {
    ...pending,
    usageInputTokens: input.usageInputTokens,
  });

  for (const lock of pending.slots) {
    if (lock.scope === null) continue;
    const memory = requireMemory(input.memories, lock.slot);
    if (memory.provider.capture === undefined) continue;
    const operationId = createCompactionOperationId({
      ordinal: pending.ordinal,
      phase: "compaction.requested",
      scope: lock.scope,
      sessionId: pending.session.id,
      slot: lock.slot,
    });
    const context: MemoryCaptureContext = {
      ...createOperationContext({
        abortSignal,
        callbackSession: pending.session,
        messages: input.messages,
        operationId,
        scope: lock.scope,
        slot: lock.slot,
      }),
      compaction: {
        modelId: pending.modelId,
        usageInputTokens: input.usageInputTokens,
      },
      phase: "compaction.requested",
      turn: pending.turn,
    };

    try {
      await memory.provider.capture(context);
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

/** Appends post-compaction recall messages to the rewritten durable history. */
export async function finishMemoryCompaction(input: {
  readonly abortSignal?: AbortSignal;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly messages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): Promise<{ readonly failure?: MemoryOperationError; readonly session: HarnessSession }> {
  if (input.memories.length === 0) return { session: input.session };
  const pending = getPendingMemoryCompaction(input.session);
  if (pending === null) {
    throw new Error("Memory compaction completion has no matching requested lifecycle.");
  }

  const abortSignal = resolveAbortSignal(input.abortSignal);
  let session = { ...input.session, history: [...input.messages] };

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
          slot: lock.slot,
        }),
        compaction: { modelId: pending.modelId },
        phase: "compaction.completed",
        turn: pending.turn,
      };
      const result = await memory.provider.recall(context);
      session = appendRecallResult({
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

/** Runs best-effort completed-turn captures in stable slot order. */
export async function captureCompletedMemoryTurn(input: {
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
      turnId: active.turn.id,
    });

    try {
      const memory = requireMemory(input.memories, lock.slot);
      if (memory.provider.capture === undefined) continue;
      const context: MemoryCaptureContext = {
        ...createOperationContext({
          abortSignal,
          callbackSession: active.session,
          messages: input.messages,
          operationId,
          scope: lock.scope,
          slot: lock.slot,
        }),
        phase: "turn.completed",
        turn: active.turn,
      };
      await memory.provider.capture(context);
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
        origin.turnState.turn.id === active.turn.id &&
        origin.turnState.turn.sequence === active.turn.sequence,
    )
    .map((origin) => origin.callId);
  const session = releaseMemoryToolOrigins({ callIds: originCallIds, session: input.session });
  return setActiveMemoryTurn(session, null);
}

function appendRecallResult(input: {
  readonly result: MemoryRecallResult;
  readonly scope: MemoryScope;
  readonly session: HarnessSession;
  readonly slot: string;
}): HarnessSession {
  if (input.result === null || input.result === undefined) return input.session;
  const normalized = normalizeInstructionsDefinition(
    // Recall messages default to the user role, unlike system-default instructions.
    { ...input.result, role: input.result.role ?? "user" },
    `Memory provider "${input.slot}" returned an invalid recall message.`,
  );
  const content = normalized.content.trim();
  if (content.length === 0) return input.session;
  const message = attributeMemoryMessage(
    { content, role: normalized.role },
    { scope: { ...input.scope }, slot: input.slot },
  );
  return { ...input.session, history: [...input.session.history, message] };
}

async function resolveMemorySlots(input: {
  readonly defaultNamespaceContext: MemoryDefaultNamespaceContext;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly scopeContext: MemoryScopeContext;
}): Promise<readonly DurableMemorySlotLock[]> {
  const slots: DurableMemorySlotLock[] = [];
  for (const memory of sortMemories(input.memories)) {
    const value = await resolveScope(memory.slot, memory.scope, input.scopeContext);
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
    namespace =
      typeof definition === "function"
        ? await definition({ appRoot: context.appRoot, node: context.node, slot })
        : definition;
  } catch (cause) {
    throw new Error(`Memory namespace "${slot}" failed to resolve.`, { cause });
  }
  if (namespace === null) return null;
  validateResolvedValue("namespace", slot, namespace);
  return namespace;
}

async function resolveScope(
  slot: string,
  definition: MemoryScopeDefinition,
  context: MemoryScopeContext,
): Promise<string | null> {
  let scope: unknown;
  const fromResolver = typeof definition === "function";
  try {
    scope = fromResolver ? await definition(context) : definition;
  } catch (cause) {
    throw new Error(`Memory scope "${slot}" failed to resolve.`, { cause });
  }
  if (scope === null) return null;
  if (fromResolver && Array.isArray(scope)) {
    validateScopeComponents(slot, scope);
    return scope.join(":");
  }
  validateResolvedValue("scope", slot, scope);
  return scope;
}

function createScopeContext(abortSignal: AbortSignal): MemoryScopeContext {
  return { abortSignal, ...buildResolveRequestContext(loadContext()) };
}

function validateScopeComponents(
  slot: string,
  components: readonly unknown[],
): asserts components is readonly string[] {
  if (
    components.length === 0 ||
    components.some((component) => typeof component !== "string" || component.length === 0)
  ) {
    throw new TypeError(
      `Memory scope "${slot}" resolver must return a non-empty array of non-empty strings.`,
    );
  }
}

function validateResolvedValue(
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
