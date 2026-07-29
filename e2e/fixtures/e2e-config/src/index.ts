import type { AgentDefinition } from "eve";

type E2EAgentConfig = Pick<AgentDefinition, "experimental" | "model">;

/**
 * Returns the harness-owned configuration shared by e2e fixture root agents.
 */
export function e2eAgentConfig(): E2EAgentConfig {
  const model = process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol";
  const workflowWorld = process.env.EVE_E2E_WORKFLOW_WORLD;
  if (workflowWorld === undefined) {
    return { model };
  }

  return {
    model,
    experimental: { workflow: { world: workflowWorld } },
  };
}
