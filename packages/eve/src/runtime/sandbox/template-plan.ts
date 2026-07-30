import type { CompiledWorkspaceResourceRoot } from "#compiler/manifest.js";
import type { ResolvedSandboxDefinition } from "#runtime/types.js";

/**
 * Summary of the statically exported templates for one sandbox definition.
 */
export interface RuntimeSandboxTemplatePlan {
  readonly contentHash?: string;
  readonly exports: readonly string[];
}

export function createRuntimeSandboxTemplatePlan(input: {
  readonly definition: ResolvedSandboxDefinition;
  readonly workspaceResourceRoot: CompiledWorkspaceResourceRoot;
}): RuntimeSandboxTemplatePlan {
  return {
    contentHash: input.workspaceResourceRoot.contentHash,
    exports: input.definition.templates.map((template) => template.exportName),
  };
}
