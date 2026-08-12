import type { CompiledMemoryDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { createMemoryProviderContext } from "#context/memory-lifecycle.js";
import { expectFunction, expectObjectRecord } from "#internal/authored-module.js";
import type { MemoryProvider, MemoryScopeDefinition } from "#public/memory/index.js";
import { resolveLoadedDynamicToolDefinition } from "#runtime/resolve-dynamic-tool.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";

const MEMORY_EVENT_NAMES = new Set([
  "compaction.completed",
  "compaction.requested",
  "message.received",
  "turn.completed",
  "turn.started",
]);
const MEMORY_TOOL_EVENT_NAMES = new Set(["step.started"]);

/** Resolves and validates one compiled authored memory slot. */
export async function resolveMemoryDefinition(
  definition: CompiledMemoryDefinition,
  moduleMap: CompiledModuleMap,
  nodeId: string | undefined,
): Promise<ResolvedMemoryDefinition> {
  try {
    const loaded = await loadResolvedModuleExport({
      definition,
      kindLabel: "memory",
      moduleMap,
      nodeId,
    });
    const value = expectObjectRecord(loaded, describe(definition, "to return an object"));
    const provider = expectObjectRecord(
      value.provider,
      describe(definition, "to provide a provider object"),
    ) as MemoryProvider;
    const scope = expectFunction<MemoryScopeDefinition>(
      value.scope,
      describe(definition, "to provide a scope resolver"),
    );
    validateHandlerMap(definition, provider.events, MEMORY_EVENT_NAMES);

    const dynamicToolResolver = resolveMemoryTools(definition, provider);
    return {
      dynamicToolResolver,
      exportName: definition.exportName,
      logicalPath: definition.logicalPath,
      provider,
      scope,
      slot: definition.slot,
      sourceId: definition.sourceId,
      sourceKind: "module",
    } satisfies ResolvedMemoryDefinition;
  } catch (error) {
    if (error instanceof ResolveAgentError) throw error;
    throw new ResolveAgentError(
      `Failed to resolve memory from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      { logicalPath: definition.logicalPath, sourceId: definition.sourceId },
    );
  }
}

function resolveMemoryTools(
  definition: CompiledMemoryDefinition,
  provider: MemoryProvider,
): ResolvedMemoryDefinition["dynamicToolResolver"] {
  if (provider.tools === undefined) return undefined;
  const events = expectObjectRecord(
    provider.tools.events,
    describe(definition, "to provide dynamic tool events"),
  );
  validateHandlerMap(definition, events, MEMORY_TOOL_EVENT_NAMES);

  const resolver = resolveLoadedDynamicToolDefinition(
    { ...provider.tools },
    {
      extensionNamespace: definition.slot,
      logicalPath: definition.logicalPath,
      slug: `memory:${definition.slot}`,
      sourceId: `${definition.sourceId}#tools`,
      sourceKind: "module",
    },
    Object.keys(events),
  );
  return {
    ...resolver,
    buildContext: ({ abortSignal, messages }) =>
      createMemoryProviderContext({ abortSignal, messages, slot: definition.slot }),
  };
}

function validateHandlerMap(
  definition: CompiledMemoryDefinition,
  value: unknown,
  allowedNames: ReadonlySet<string>,
): void {
  if (value === undefined) return;
  const handlers = expectObjectRecord(value, describe(definition, "to provide an events object"));
  for (const [eventName, handler] of Object.entries(handlers)) {
    if (!allowedNames.has(eventName)) {
      throw new Error(
        describe(
          definition,
          `to use a supported event key, but received ${JSON.stringify(eventName)}`,
        ),
      );
    }
    expectFunction(
      handler,
      describe(definition, `to provide a handler for events[${JSON.stringify(eventName)}]`),
    );
  }
}

function describe(definition: CompiledMemoryDefinition, predicate: string): string {
  return `Expected the memory export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
}
