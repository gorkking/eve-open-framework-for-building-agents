import { defineEval } from "eve/evals";

const MARKER = "authored-always-unrelated-input-P7M2";
const TOOL_NAME = "gate";

/** Regression reproduction for https://github.com/vercel/eve/issues/1224. */
export default defineEval({
  tags: ["real-model"],
  description: "HITL repro (#1224): unrelated input denies the authored tool call and continues.",
  async test(t) {
    const parked = await t.send(`Call the \`${TOOL_NAME}\` tool with marker "${MARKER}".`);
    parked.calledTool(TOOL_NAME, { status: "pending", count: 1 });
    t.requireInputRequest({
      display: "confirmation",
      toolName: TOOL_NAME,
    });

    const unrelated = await t.send("Reply with exactly ORBITAL-PINE-6C3R.");

    unrelated.expectOk();
    unrelated.event("action.result", {
      data: { result: { toolName: TOOL_NAME }, status: "rejected" },
      count: 1,
    });
    unrelated.messageIncludes(/ORBITAL-PINE-6C3R/i);
    t.succeeded();
  },
});
