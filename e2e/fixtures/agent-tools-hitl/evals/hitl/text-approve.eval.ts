import { defineEval } from "eve/evals";

/**
 * HITL flow: a plain follow-up message is not an approval response, even when
 * its text matches the approve option.
 */
export default defineEval({
  tags: ["real-model"],
  description: "HITL smoke: text approve denies a pending tool approval.",
  async test(t) {
    const parked = await t.send('Call the guarded-echo tool with note "text-approve".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    t.requireInputRequest({ display: "confirmation", toolName: "guarded-echo" });

    const resumed = await t.send("approve");
    resumed.expectOk();
    resumed.event("action.result", {
      data: { result: { toolName: "guarded-echo" }, status: "rejected" },
      count: 1,
    });

    t.succeeded();
  },
});
