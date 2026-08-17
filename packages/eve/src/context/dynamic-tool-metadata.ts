import type { DurableDynamicToolMetadata } from "#context/keys.js";

export function requiresLiveDynamicToolExecution(metadata: DurableDynamicToolMetadata): boolean {
  return metadata.executeStepFnName?.startsWith("eve:framework-dynamic:") === true;
}

export function requiresLiveDynamicTool(metadata: DurableDynamicToolMetadata): boolean {
  if (metadata.requiresLiveDefinition === true) return true;

  // Metadata written before `requiresLiveDefinition` must still hydrate on
  // bundled runtimes whose revision key can remain stable across upgrades.
  return (
    metadata.requiresLiveDefinition === undefined &&
    (metadata.approvalStepFnName !== undefined || requiresLiveDynamicToolExecution(metadata))
  );
}
