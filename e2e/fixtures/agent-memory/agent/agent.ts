import { e2eAgentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

import { MEMORY_FACT, MEMORY_PHRASE, SAVE_CONFIRMATION } from "./constants.js";

function respond(request: MockModelRequest): MockModelResponse | string {
  const prompt = request.lastUserMessage ?? "";

  if (prompt.includes("user__save_memory") && prompt.includes(MEMORY_FACT)) {
    const saved = request.toolResults.some((result) => result.name === "user__save_memory");
    return saved
      ? SAVE_CONFIRMATION
      : { toolCalls: [{ input: { text: MEMORY_FACT }, name: "user__save_memory" }] };
  }

  if (/verification phrase/iu.test(prompt)) {
    const recalls = request.userMessages.filter((message) => message.includes(MEMORY_FACT));
    return recalls.length === 1
      ? MEMORY_PHRASE
      : recalls.length === 0
        ? "MEMORY-NOT-FOUND"
        : "MEMORY-DUPLICATED";
  }

  return `Mock reply: ${prompt}`;
}

export default defineAgent({
  ...e2eAgentConfig({ mock: respond }),
  reasoning: "high",
});
