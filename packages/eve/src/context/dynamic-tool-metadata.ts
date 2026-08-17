import type { DurableDynamicToolMetadata } from "#context/keys.js";

export function requiresLiveDynamicToolExecution(metadata: DurableDynamicToolMetadata): boolean {
  return metadata.executeStepFnName?.startsWith("eve:framework-dynamic:") === true;
}

export function requiresLiveDynamicTool(metadata: DurableDynamicToolMetadata): boolean {
  return metadata.approvalStepFnName !== undefined || requiresLiveDynamicToolExecution(metadata);
}
