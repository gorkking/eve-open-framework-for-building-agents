import type { ModelMessage } from "ai";

import { buildCallbackContext } from "#context/build-callback-context.js";
import { replayDynamicTools } from "#context/build-dynamic-tools.js";
import { loadContext } from "#context/container.js";
import { resolveDynamicToolEvent } from "#context/dynamic-tool-lifecycle.js";
import type { DurableDynamicToolMetadata } from "#context/keys.js";
import { cloneScope, cloneTurn, principalIdentity } from "#context/memory-operation.js";
import {
  getActiveMemoryTurn,
  getMemoryToolOriginCallIds as getStoredMemoryToolOriginCallIds,
  getMemoryToolOrigins,
  recordMemoryToolOrigins,
  releaseMemoryToolOrigins,
  restoreMemoryTurnFromToolOrigins,
  setActiveMemoryTurn,
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
import { defineDynamic } from "#public/definitions/tool.js";
import type { MemoryScope, MemoryToolsContext } from "#public/memory/index.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import { resolveLoadedDynamicToolDefinition } from "#runtime/resolve-dynamic-tool.js";
import type { ResolvedDynamicToolResolver, ResolvedMemoryDefinition } from "#runtime/types.js";
import { isBrandedToolEntry } from "#shared/dynamic-tool-definition.js";

type ReplayedDynamicTool = ReturnType<typeof replayDynamicTools>[number];
type ActiveMemoryTurn = NonNullable<ReturnType<typeof getActiveMemoryTurn>>;

/** Resolves each active provider's tools through the turn-scoped dynamic tool engine. */
export async function resolveMemoryTurnTools(input: {
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly messages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): Promise<HarnessSession> {
  const active = getActiveMemoryTurn(input.session);
  if (active === null) {
    throw new Error("Memory tools require an active turn scope.");
  }

  const descriptionByResolver = new Map<string, string>();
  const resolvers = active.slots.flatMap((lock) => {
    if (lock.scope === null) return [];
    const memory = input.memories.find((candidate) => candidate.slot === lock.slot);
    if (memory === undefined) {
      throw new Error(`Memory slot "${lock.slot}" is unavailable in the active runtime revision.`);
    }
    if (memory.provider.tools === undefined) return [];
    const resolver = createMemoryToolResolver({
      active,
      memory,
      scope: lock.scope,
      slot: lock.slot,
    });
    if (memory.description !== undefined) {
      descriptionByResolver.set(resolver.slug, memory.description);
    }
    return [resolver];
  });

  const event = {
    data: {
      sequence: active.turn.sequence,
      turnId: active.turn.id,
    },
    type: "turn.started",
  } as UnstampedMessageStreamEvent;
  const { metadata: resolvedMetadata } =
    resolvers.length === 0
      ? { metadata: [] }
      : await resolveDynamicToolEvent({
          ctx: loadContext(),
          event,
          messages: input.messages,
          resolvers,
        });
  const metadata = prependMemoryDescriptions(resolvedMetadata, descriptionByResolver);

  return setActiveMemoryTurn(input.session, { ...active, toolMetadata: metadata });
}

function prependMemoryDescriptions(
  metadata: readonly DurableDynamicToolMetadata[],
  descriptionByResolver: ReadonlyMap<string, string>,
): readonly DurableDynamicToolMetadata[] {
  return metadata.map((tool) => {
    const description = descriptionByResolver.get(tool.resolverSlug);
    return description === undefined
      ? tool
      : { ...tool, description: `${description}\n\n${tool.description}` };
  });
}

/** Reconstructs the current turn's memory tools without invoking a provider resolver. */
export function buildMemoryTools(session: HarnessSession): HarnessToolMap {
  const metadata = getActiveMemoryTurn(session)?.toolMetadata ?? [];
  return new Map(replayDynamicTools(metadata).map((tool) => [tool.name, tool] as const));
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
  readonly session: HarnessSession;
}): HarnessSession {
  return restoreMemoryTurnFromToolOrigins(input);
}

/** Replays parked tools from their captured dynamic metadata. */
export async function resolveMemoryApprovalTools(input: {
  readonly callIds: readonly string[];
  readonly session: HarnessSession;
}): Promise<HarnessMemoryApprovalTools> {
  if (input.callIds.length === 0) return createMemoryApprovalTools(new Map());
  const origins = getMemoryToolOrigins(input.session, input.callIds);
  if (origins.length === 0) return createMemoryApprovalTools(new Map());

  const byName = new Map<
    string,
    Array<{ readonly definition: ReplayedDynamicTool; readonly origin: DurableMemoryToolOrigin }>
  >();
  for (const origin of origins) {
    const definition = replayDynamicTools([origin.toolMetadata])[0];
    if (definition === undefined) {
      throw new Error(`Memory tool "${origin.toolName}" is unavailable during approval resume.`);
    }
    const entries = byName.get(origin.toolName) ?? [];
    entries.push({ definition, origin });
    byName.set(origin.toolName, entries);
  }

  return createMemoryApprovalTools(byName);
}

function createMemoryToolResolver(input: {
  readonly active: ActiveMemoryTurn;
  readonly memory: ResolvedMemoryDefinition;
  readonly scope: MemoryScope;
  readonly slot: string;
}): ResolvedDynamicToolResolver {
  const resolveTools = input.memory.provider.tools;
  if (resolveTools === undefined) {
    throw new Error(`Memory provider "${input.slot}" does not define tools.`);
  }
  const dynamic = defineDynamic({
    events: {
      "turn.started": async (_event, resolveContext) => {
        const context: MemoryToolsContext = {
          ...resolveContext,
          memory: {
            scope: cloneScope(input.scope),
            slot: input.slot,
          },
          turn: cloneTurn(input.active.turn),
        };
        const result = await resolveTools(context);
        if (isBrandedToolEntry(result)) {
          throw new TypeError(
            `Memory provider "${input.slot}" must return a map of defineTool() values, not one tool.`,
          );
        }
        return result;
      },
    },
  });

  return resolveLoadedDynamicToolDefinition(
    dynamic,
    {
      exportName: input.memory.exportName,
      extensionNamespace: input.slot,
      logicalPath: input.memory.logicalPath,
      slug: `memory:${input.slot}`,
      sourceId: `${input.memory.sourceId}:memory-tools`,
      sourceKind: "module",
    },
    ["turn.started"],
  );
}

function createMemoryApprovalTools(
  byName: ReadonlyMap<
    string,
    readonly {
      readonly definition: ReplayedDynamicTool;
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

function multiplexOriginTools(
  name: string,
  entries: readonly {
    readonly definition: ReplayedDynamicTool;
    readonly origin: DurableMemoryToolOrigin;
  }[],
  fallback: ReplayedDynamicTool | undefined,
): ReplayedDynamicTool {
  const first = entries[0]?.definition;
  if (first === undefined) throw new Error(`Memory tool "${name}" has no approval origin.`);
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
  definitions: ReadonlyMap<string, ReplayedDynamicTool>,
  fallback: ReplayedDynamicTool | undefined,
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
  definitions: ReadonlyMap<string, ReplayedDynamicTool>,
  callId: string,
  fallback: ReplayedDynamicTool | undefined,
  toolName: string,
): ReplayedDynamicTool {
  const definition = definitions.get(callId) ?? fallback;
  if (definition === undefined) {
    throw new Error(`Memory tool "${toolName}" has no scope lock for call "${callId}".`);
  }
  return definition;
}
