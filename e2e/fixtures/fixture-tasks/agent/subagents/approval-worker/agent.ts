import { defineAgent } from "eve";
import { mockModel, type MockModelRequest, type MockModelResponse } from "eve/evals";

function respond(request: MockModelRequest): MockModelResponse | string {
  const first = request.toolResults.find((result) => result.name === "first_gate");
  if (first === undefined) {
    return {
      toolCalls: [{ id: "approval-first", input: { marker: "FIRST" }, name: "first_gate" }],
    };
  }

  const second = request.toolResults.find((result) => result.name === "second_gate");
  if (second === undefined) {
    return {
      toolCalls: [{ id: "approval-second", input: { marker: "SECOND" }, name: "second_gate" }],
    };
  }

  return "CHILD-GATES-COMPLETE";
}

export default defineAgent({
  description: "Run two deterministic approval gates in order.",
  model: mockModel(respond),
  modelContextWindowTokens: 1_000_000,
});
