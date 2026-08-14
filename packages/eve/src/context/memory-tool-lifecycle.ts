import type { ModelMessage } from "ai";

import { buildCallbackContext } from "#context/build-callback-context.js";
import {
  cloneProjection,
  cloneScope,
  cloneTurn,
  createMemoryOperationId,
  createToolsContext,
  MemoryOperationError,
  principalIdentity,
  requireMemory,
  resolveAbortSignal,
} from "#context/memory-operation.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import {
  anchorUnanchoredVisibleMemoryProjections,
  getActiveMemoryTurn,
  getMemoryToolOriginCallIds as getStoredMemoryToolOriginCallIds,
  getMemoryToolOrigins,
  recordMemoryToolOrigins,
  releaseMemoryToolOrigins,
  restoreMemoryTurnFromToolOrigins,
  setActiveMemoryToolOperations,
  setActiveMemoryTurn,
  type DurableMemoryToolOperation,
  type DurableMemoryToolOrigin,
} from "#harness/memory-state.js";
import type { HarnessMemoryApprovalTools, HarnessSession, HarnessToolMap } from "#harness/types.js";
import {
  resolveApprovalPolicy,
  type Approval,
  type ApprovalConfiguration,
  type ApprovalContext,
  type ApprovalResponseContext,
  type ApprovalResponseDecision,
  type ApprovalStatus,
} from "#public/definitions/approval.js";
import type { MemoryToolSet } from "#public/memory/index.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
import { isBrandedToolEntry } from "#shared/dynamic-tool-definition.js";
import { toInputSchema, toOutputSchema } from "#shared/tool-schema.js";

/** Resolves and qualifies scope-bound tools for one model step. */
export async function resolveMemoryTools(input: {
  readonly abortSignal?: AbortSignal;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly messages: readonly ModelMessage[];
  readonly modelId: string;
  readonly session: HarnessSession;
}): Promise<{ readonly session: HarnessSession; readonly tools: HarnessToolMap }> {
  if (input.memories.length === 0) {
    return { session: input.session, tools: new Map() };
  }
  const active = getActiveMemoryTurn(input.session);
  if (active === null) {
    throw new Error("Memory tools require an active turn scope.");
  }

  const abortSignal = resolveAbortSignal(input.abortSignal);
  const tools = new Map<string, HarnessToolDefinition>();
  const operations: DurableMemoryToolOperation[] = [];
  const stepIndex = active.nextStepIndex;
  const nextTurn = { ...active, nextStepIndex: stepIndex + 1 };

  for (const lock of active.slots) {
    if (lock.scope === null) continue;
    const memory = requireMemory(input.memories, lock.slot);
    if (memory.provider.tools === undefined) continue;
    const operationId = createStepOperationId({
      scopeKey: lock.scope.key,
      sessionId: active.session.id,
      slot: lock.slot,
      stepIndex,
      turnId: active.turn.turnId,
    });
    const context = createToolsContext({
      abortSignal,
      callbackSession: active.session,
      messages: input.messages,
      modelId: input.modelId,
      operationId,
      scope: lock.scope,
      session: input.session,
      slot: lock.slot,
      stepIndex,
      turn: active.turn,
    });

    try {
      const resolved = await memory.provider.tools(context);
      const slotTools = lowerMemoryToolSet(lock.slot, resolved);
      for (const [name, definition] of slotTools) {
        if (tools.has(name)) {
          throw new Error(`Memory tool "${name}" was resolved more than once.`);
        }
        tools.set(name, definition);
      }
      if (slotTools.size > 0) {
        operations.push({
          current: cloneProjection(context.memory.current),
          messages: [...input.messages],
          modelId: input.modelId,
          operationId,
          principalIdentity: active.principalIdentity,
          scope: cloneScope(lock.scope),
          session: active.session,
          slot: lock.slot,
          stepIndex,
          toolNames: [...slotTools.keys()],
          turn: cloneTurn(active.turn),
          turnState: nextTurn,
        });
      }
    } catch (cause) {
      throw new MemoryOperationError({
        cause,
        operationId,
        phase: "step.started",
        slot: lock.slot,
      });
    }
  }

  return {
    session: setActiveMemoryToolOperations(
      setActiveMemoryTurn(input.session, nextTurn),
      operations,
    ),
    tools,
  };
}

/** Returns parked origins, filtering authorization callbacks to the active principal. */
export function getMemoryToolOriginCallIds(
  session: HarnessSession,
  authorizationAttemptIds?: readonly string[],
): string[] {
  const callIds = getStoredMemoryToolOriginCallIds(session, authorizationAttemptIds);
  if (authorizationAttemptIds === undefined) return callIds;
  const currentPrincipal = principalIdentity(buildCallbackContext().session.auth.current);
  const allowed = new Set(
    getMemoryToolOrigins(session, callIds)
      .filter((origin) => origin.principalIdentity === currentPrincipal)
      .map((origin) => origin.callId),
  );
  return callIds.filter((callId) => allowed.has(callId));
}

/** Persists call-id-addressable, serializable origins for memory tools that may park. */
export { recordMemoryToolOrigins, releaseMemoryToolOrigins };

/** Restores the full originating turn lock before an approved tool continuation. */
export function restoreMemoryToolTurn(input: {
  readonly callIds: readonly string[];
  readonly projectionAnchorIndex: number;
  readonly session: HarnessSession;
}): HarnessSession {
  const session = restoreMemoryTurnFromToolOrigins(input);
  const active = getActiveMemoryTurn(session);
  if (active === null) return session;
  return anchorUnanchoredVisibleMemoryProjections({
    anchorIndex: input.projectionAnchorIndex,
    session,
    slots: active.slots,
  });
}

/** Reconstructs live provider tools from their original durable step contexts. */
export async function resolveMemoryApprovalTools(input: {
  readonly abortSignal?: AbortSignal;
  readonly callIds: readonly string[];
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly session: HarnessSession;
}): Promise<HarnessMemoryApprovalTools> {
  if (input.callIds.length === 0) return createMemoryApprovalTools(new Map());
  const abortSignal = resolveAbortSignal(input.abortSignal);
  const origins = getMemoryToolOrigins(input.session, input.callIds);
  if (origins.length === 0) return createMemoryApprovalTools(new Map());

  const byName = new Map<
    string,
    Array<{ readonly definition: HarnessToolDefinition; readonly origin: DurableMemoryToolOrigin }>
  >();
  const toolsByOperation = new Map<string, HarnessToolMap>();
  for (const origin of origins) {
    let operationTools = toolsByOperation.get(origin.operationId);
    if (operationTools === undefined) {
      const memory = requireMemory(input.memories, origin.slot);
      if (memory.provider.tools === undefined) {
        throw new Error(`Memory tool "${origin.toolName}" is unavailable during approval resume.`);
      }
      const context = createToolsContext({
        abortSignal,
        callbackSession: origin.session,
        current: origin.current,
        messages: origin.messages,
        modelId: origin.modelId,
        operationId: origin.operationId,
        scope: origin.scope,
        session: input.session,
        slot: origin.slot,
        stepIndex: origin.stepIndex,
        turn: origin.turn,
      });
      try {
        operationTools = lowerMemoryToolSet(origin.slot, await memory.provider.tools(context));
        toolsByOperation.set(origin.operationId, operationTools);
      } catch (cause) {
        throw new MemoryOperationError({
          cause,
          operationId: origin.operationId,
          phase: "step.started",
          slot: origin.slot,
        });
      }
    }
    const definition = operationTools.get(origin.toolName);
    if (definition === undefined) {
      throw new Error(`Memory tool "${origin.toolName}" is unavailable during approval resume.`);
    }
    const entries = byName.get(origin.toolName) ?? [];
    entries.push({ definition, origin });
    byName.set(origin.toolName, entries);
  }

  return createMemoryApprovalTools(byName);
}

function createMemoryApprovalTools(
  byName: ReadonlyMap<
    string,
    readonly {
      readonly definition: HarnessToolDefinition;
      readonly origin: DurableMemoryToolOrigin;
    }[]
  >,
): HarnessMemoryApprovalTools {
  const select = (callIds: readonly string[], fallbackTools?: HarnessToolMap): HarnessToolMap => {
    const selectedCallIds = new Set(callIds);
    const tools = new Map(fallbackTools);
    for (const [name, entries] of byName) {
      const selected = entries.filter((entry) => selectedCallIds.has(entry.origin.callId));
      if (selected.length > 0) {
        tools.set(name, multiplexOriginTools(name, selected, fallbackTools?.get(name)));
      }
    }
    return tools;
  };

  const callIds = [...byName.values()].flatMap((entries) =>
    entries.map((entry) => entry.origin.callId),
  );
  return {
    select: ({ callIds: selectedCallIds, fallbackTools }) => select(selectedCallIds, fallbackTools),
    tools: select(callIds),
  };
}

function lowerMemoryToolSet(slot: string, value: MemoryToolSet | null): HarnessToolMap {
  if (value === null) return new Map();
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Memory provider "${slot}" returned an invalid tool set.`);
  }

  const tools = new Map<string, HarnessToolDefinition>();
  for (const key of Object.keys(value).sort(compareStrings)) {
    if (key.length === 0) {
      throw new TypeError(`Memory provider "${slot}" returned an empty tool name.`);
    }
    const candidate = value[key];
    if (!isBrandedToolEntry(candidate)) {
      throw new TypeError(
        `Memory provider "${slot}" tool "${key}" must be created with defineTool(...).`,
      );
    }
    const authored = candidate!;
    const qualifiedName = `${slot}__${key}`;
    tools.set(qualifiedName, {
      approval: authored.approval,
      description: authored.description,
      execute: createToolExecuteWithAuth({
        execute: authored.execute as (toolInput: unknown, context: unknown) => unknown,
        scope: qualifiedName,
      }),
      inputSchema: toInputSchema(authored.inputSchema),
      name: qualifiedName,
      outputSchema: toOutputSchema(authored.outputSchema),
      toModelOutput: authored.toModelOutput as ((output: unknown) => unknown) | undefined,
    });
  }
  return tools;
}

function multiplexOriginTools(
  name: string,
  entries: readonly {
    readonly definition: HarnessToolDefinition;
    readonly origin: DurableMemoryToolOrigin;
  }[],
  fallback: HarnessToolDefinition | undefined,
): HarnessToolDefinition {
  const first = entries[0]?.definition;
  if (first === undefined) throw new Error(`Memory tool "${name}" has no approval origin.`);
  // A current definition owns what the model sees. Providers must keep a
  // parked key's schemas compatible until its historical calls settle.
  const base = fallback ?? first;

  const byCallId = new Map(
    entries.map((entry) => [entry.origin.callId, entry.definition] as const),
  );
  return {
    ...base,
    approval: multiplexApproval(byCallId, fallback),
    execute: (toolInput, options) => {
      const execute = resolveOriginDefinition(byCallId, options.toolCallId, fallback, name).execute;
      if (execute === undefined) throw new Error(`Memory tool "${name}" is not executable.`);
      return execute(toolInput, options);
    },
    resolveToModelOutput: (callId) =>
      callId === undefined
        ? base.toModelOutput
        : resolveOriginDefinition(byCallId, callId, fallback, name).toModelOutput,
  };
}

function multiplexApproval(
  definitions: ReadonlyMap<string, HarnessToolDefinition>,
  fallback: HarnessToolDefinition | undefined,
): Approval | undefined {
  if (
    fallback?.approval === undefined &&
    [...definitions.values()].every((definition) => definition.approval === undefined)
  ) {
    return undefined;
  }
  const approval: ApprovalConfiguration = {
    request: async (context: ApprovalContext): Promise<ApprovalStatus> => {
      const selected = resolveOriginDefinition(
        definitions,
        context.callId,
        fallback,
        context.toolName,
      ).approval;
      return selected === undefined ? undefined : await resolveApprovalPolicy(selected)(context);
    },
    response: async (context: ApprovalResponseContext): Promise<ApprovalResponseDecision> => {
      const selected = resolveOriginDefinition(
        definitions,
        context.request.callId,
        fallback,
        context.request.toolName,
      ).approval;
      if (
        selected === undefined ||
        typeof selected === "function" ||
        selected.response === undefined
      ) {
        return { status: "allowed" };
      }
      return await selected.response(context);
    },
  };
  return approval;
}

function resolveOriginDefinition(
  definitions: ReadonlyMap<string, HarnessToolDefinition>,
  callId: string,
  fallback: HarnessToolDefinition | undefined,
  toolName: string,
): HarnessToolDefinition {
  const definition = definitions.get(callId) ?? fallback;
  if (definition === undefined) {
    throw new Error(`Memory tool "${toolName}" has no scope lock for call "${callId}".`);
  }
  return definition;
}

function createStepOperationId(input: {
  readonly scopeKey: string;
  readonly sessionId: string;
  readonly slot: string;
  readonly stepIndex: number;
  readonly turnId: string;
}): string {
  return createMemoryOperationId([
    input.sessionId,
    input.slot,
    input.scopeKey,
    "step.started",
    input.turnId,
    input.stepIndex,
  ]);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
