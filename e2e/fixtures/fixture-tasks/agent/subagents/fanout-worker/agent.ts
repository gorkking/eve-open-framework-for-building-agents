import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Complete one fanout task with its deterministic marker.",
  model: mockModel(({ lastUserMessage }) => `FANOUT-COMPLETE:${lastUserMessage ?? ""}`),
  modelContextWindowTokens: 1_000_000,
});
