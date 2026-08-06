import { defineAgent } from "eve";
import { mockModel } from "eve/evals";

export default defineAgent({
  description: "Return one deterministic marker for each message.",
  model: mockModel(({ lastUserMessage }) => `BUSY-WORKER:${lastUserMessage ?? ""}`),
  modelContextWindowTokens: 1_000_000,
});
