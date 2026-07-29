import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

const workflowWorld = process.env.EVE_E2E_WORKFLOW_WORLD;

export default defineAgent({
  experimental: workflowWorld === undefined ? undefined : { workflow: { world: workflowWorld } },
  model: mockModel(
    ({ lastUserMessage, userMessageCount }) =>
      `stress-ack:${userMessageCount}:${lastUserMessage ?? ""}`,
  ),
  modelContextWindowTokens: 1_000_000,
});
