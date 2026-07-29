import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  ...e2eAgentConfig(),
  model: mockModel(
    ({ lastUserMessage, userMessageCount }) =>
      `stress-ack:${userMessageCount}:${lastUserMessage ?? ""}`,
  ),
  modelContextWindowTokens: 1_000_000,
});
