import type { CompiledMemoryDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
} from "#internal/authored-module.js";
import type {
  MemoryProvider,
  MemoryScopeDefinition,
  MemoryVisibility,
} from "#public/memory/index.js";
import { loadResolvedModuleExport, ResolveAgentError } from "#runtime/resolve-helpers.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";

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
    expectOnlyKnownKeys(
      value,
      ["provider", "scope", "visibility"],
      describe(definition, "to use only supported definition fields."),
    );

    const provider = resolveProvider(definition, value.provider);
    const scope = expectFunction<MemoryScopeDefinition>(
      value.scope,
      describe(definition, "to provide a scope resolver"),
    );
    const visibility = resolveVisibility(definition, value.visibility);

    return {
      exportName: definition.exportName,
      logicalPath: definition.logicalPath,
      provider,
      scope,
      slot: definition.slot,
      sourceId: definition.sourceId,
      sourceKind: "module",
      visibility,
    } satisfies ResolvedMemoryDefinition;
  } catch (error) {
    if (error instanceof ResolveAgentError) throw error;
    throw new ResolveAgentError(
      `Failed to resolve memory from "${definition.logicalPath}": ${toErrorMessage(error)}`,
      { logicalPath: definition.logicalPath, sourceId: definition.sourceId },
    );
  }
}

function resolveProvider(definition: CompiledMemoryDefinition, value: unknown): MemoryProvider {
  const provider = expectObjectRecord(value, describe(definition, "to provide a provider object"));
  expectOnlyKnownKeys(
    provider,
    ["recall", "save", "tools"],
    describe(definition, "to use only supported provider methods."),
  );
  assertMemoryProvider(definition, provider);
  return provider;
}

function assertMemoryProvider(
  definition: CompiledMemoryDefinition,
  provider: Record<string, unknown>,
): asserts provider is Record<string, unknown> & MemoryProvider {
  expectFunction<MemoryProvider["recall"]>(
    provider.recall,
    describe(definition, 'to provide a function for "provider.recall"'),
  );
  validateOptionalProviderMethod(definition, provider, "save");
  validateOptionalProviderMethod(definition, provider, "tools");
}

function validateOptionalProviderMethod(
  definition: CompiledMemoryDefinition,
  provider: Record<string, unknown>,
  method: "save" | "tools",
): void {
  if (provider[method] === undefined) return;
  expectFunction(
    provider[method],
    describe(definition, `to provide a function for "provider.${method}" when present`),
  );
}

function resolveVisibility(definition: CompiledMemoryDefinition, value: unknown): MemoryVisibility {
  if (value === undefined || value === "scope") return "scope";
  if (value === "session") return "session";
  throw new Error(describe(definition, 'to set "visibility" to either "scope" or "session"'));
}

function describe(definition: CompiledMemoryDefinition, predicate: string): string {
  return `Expected the memory export "${definition.exportName ?? "default"}" from "${definition.logicalPath}" ${predicate}.`;
}
