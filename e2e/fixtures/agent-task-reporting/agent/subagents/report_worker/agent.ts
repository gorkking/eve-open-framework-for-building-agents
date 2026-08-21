import { e2eSubagentConfig } from "@eve-e2e/config";
import { defineAgent } from "eve";
import type { MockModelRequest, MockModelResponse } from "eve/evals";

const WORK_PATTERN = /delayMs=(\d+), result=([A-Z-]+)/u;

function respond(request: MockModelRequest): MockModelResponse | string {
  const match = WORK_PATTERN.exec(request.lastUserMessage ?? "");
  const delayMs = Number(match?.[1] ?? "0");
  const result = match?.[2] ?? "MISSING-RESULT";
  if (!request.toolResults.some((entry) => entry.name === "delay")) {
    return { toolCalls: [{ input: { delayMs }, name: "delay" }] };
  }
  return result;
}

export default defineAgent({
  description: "Complete one background reporting probe after the requested delay.",
  ...e2eSubagentConfig({ mock: respond }),
  reasoning: "low",
});
