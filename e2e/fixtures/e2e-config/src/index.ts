import type { AgentDefinition } from "eve";

type E2EAgentConfig = Pick<AgentDefinition, "experimental">;

/**
 * Returns the harness-owned configuration shared by e2e fixture root agents.
 */
export function e2eAgentConfig(): E2EAgentConfig {
  const workflowWorld = process.env.EVE_E2E_WORKFLOW_WORLD;
  if (workflowWorld === undefined) {
    return {};
  }

  return {
    experimental: { workflow: { world: workflowWorld } },
  };
}
