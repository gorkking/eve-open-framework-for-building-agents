import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";

export default defineAgent({
  ...e2eAgentConfig(),
  model: process.env.EVE_E2E_MODEL ?? "openai/gpt-5.6-sol",
});
