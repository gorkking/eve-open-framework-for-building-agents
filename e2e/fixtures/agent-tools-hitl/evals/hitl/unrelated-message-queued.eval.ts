import { defineEval } from "eve/evals";

/**
 * HITL flow: unrelated text sent while an approval is pending denies the
 * approval and replays the message immediately.
 */
export default defineEval({
  description: "HITL smoke: unrelated message denies approval and resumes.",
  async test(t) {
    const parked = await t.send('Call the guarded-echo tool with note "queued-approval".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    t.requireInputRequest({
      display: "confirmation",
      toolName: "guarded-echo",
    });

    const resumed = await t.send(
      "After the pending approval is resolved, reply with exactly QUEUED-HITL-OK.",
    );
    resumed.expectOk();
    resumed.event("action.result", {
      data: { result: { toolName: "guarded-echo" }, status: "rejected" },
      count: 1,
    });
    resumed.messageIncludes(/QUEUED-HITL-OK/i);

    t.succeeded();
  },
});
