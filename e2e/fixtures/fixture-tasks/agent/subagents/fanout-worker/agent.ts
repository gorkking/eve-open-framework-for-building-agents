import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  const held = request.toolResults.find((result) => result.name === "hold");
  if (held === undefined) {
    return { toolCalls: [{ input: { milliseconds: 3_000 }, name: "hold" }] };
  }
  return `FANOUT-COMPLETE:${request.lastUserMessage ?? ""}`;
}

export default defineAgent({
  description: "Complete one fanout task with its deterministic marker.",
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
