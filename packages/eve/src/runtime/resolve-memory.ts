import type { CompiledMemoryDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import {
  expectFunction,
  expectObjectRecord,
  expectOnlyKnownKeys,
} from "#internal/authored-module.js";
import type {
  MemoryNamespaceDefinition,
  MemoryProvider,
  MemoryScopeDefinition,
  MemoryVisibility,
} from "#public/memory/index.js";
import { defaultNamespace } from "#public/memory/index.js";
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
      ["description", "namespace", "provider", "scope", "visibility"],
      describe(definition, "to use only supported definition fields."),
    );

    const description = resolveDescription(definition, value.description);
    const namespace = resolveNamespace(definition, value.namespace);
    const provider = resolveProvider(definition, value.provider);
    const scope = resolveScope(definition, value.scope);
    const visibility = resolveVisibility(definition, value.visibility);

    return {
      description,
      exportName: definition.exportName,
      logicalPath: definition.logicalPath,
      namespace,
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

function resolveDescription(
  definition: CompiledMemoryDefinition,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(describe(definition, 'to set "description" to a non-whitespace string'));
}

function resolveNamespace(
  definition: CompiledMemoryDefinition,
  value: unknown,
): MemoryNamespaceDefinition {
  if (value === undefined) return defaultNamespace;
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new Error(describe(definition, 'to set "namespace" to a non-empty string'));
    }
    return value;
  }
  if (typeof value === "function") {
    return value as MemoryNamespaceDefinition;
  }
  throw new Error(
    describe(definition, 'to set "namespace" to a string, null, or resolver function'),
  );
}

function resolveScope(definition: CompiledMemoryDefinition, value: unknown): MemoryScopeDefinition {
  if (value === null) return null;
  if (typeof value === "string") {
    if (value.length === 0) {
      throw new Error(describe(definition, 'to set "scope" to a non-empty string or null'));
    }
    return value;
  }
  if (typeof value === "function") {
    return value as MemoryScopeDefinition;
  }
  throw new Error(describe(definition, 'to set "scope" to a string, null, or resolver function'));
}

function resolveProvider(definition: CompiledMemoryDefinition, value: unknown): MemoryProvider {
  const provider = expectObjectRecord(value, describe(definition, "to provide a provider object"));
  expectOnlyKnownKeys(
    provider,
    ["recall", "capture", "tools"],
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
  validateOptionalProviderMethod(definition, provider, "capture");
  validateOptionalProviderMethod(definition, provider, "tools");
}

function validateOptionalProviderMethod(
  definition: CompiledMemoryDefinition,
  provider: Record<string, unknown>,
  method: "capture" | "tools",
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
