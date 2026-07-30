import { createSelfModifyingSandboxBackend } from "#execution/sandbox/bindings/selfmod.js";
import type { AgentReasoningDefinition } from "#shared/agent-definition.js";
import { attachSelfModifyingSandboxDefinition } from "#shared/selfmod-definition.js";

/** Configuration for a development-only source-editing subagent. */
export interface SelfModifyingAgentDefinitionInput {
  /** Guidance for when the parent should delegate. */
  readonly description?: string;
  /** Confirms that hosted builds must omit this subagent. */
  readonly development: true;
  /** Instructions appended to eve's source-editing instructions. */
  readonly instructions?: string;
  /** Model override; defaults to the parent model. */
  readonly model?: string;
  /** Reasoning override; defaults to the parent configuration. */
  readonly reasoning?: AgentReasoningDefinition;
}

/** Compiled form of a development-only source-editing subagent. */
export interface SelfModifyingAgentDefinition extends SelfModifyingAgentDefinitionInput {
  readonly kind: "selfmod";
}

/**
 * Declares a local-development subagent that can read and modify the consuming
 * eve application's live source tree. Hosted compiles omit the declaration.
 */
export function defineSelfModifyingAgent(
  input: SelfModifyingAgentDefinitionInput,
): SelfModifyingAgentDefinition {
  const definition: SelfModifyingAgentDefinition = { ...input, kind: "selfmod" };
  attachSelfModifyingSandboxDefinition(definition, {
    backend: createSelfModifyingSandboxBackend(),
    description: "Development-only live eve application source tree.",
  });
  return definition;
}
