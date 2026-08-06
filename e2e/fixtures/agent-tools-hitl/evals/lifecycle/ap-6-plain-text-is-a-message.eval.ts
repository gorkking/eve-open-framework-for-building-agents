import { defineEval } from "eve/evals";

import { gateLifecycle, GUARDED_ECHO_TOKEN, noEvent } from "./shared";

/**
 * AP-6: plain text is never a response. Typing "approve" does not settle the
 * approval; it runs as a message turn, and the request stays answerable
 * through a structured response.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description: "AP-6: typed 'approve' is a message; only structured responses settle.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-6".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({ display: "confirmation", toolName: "guarded-echo" });

    const typed = await t.send("approve");
    typed.expectOk();
    typed.eventsSatisfy(
      "typed approve settles nothing",
      (events) => noEvent(events, "input.responded") && noEvent(events, "input.dismissed"),
    );
    typed.notEvent("action.result", {
      data: { result: { toolName: "guarded-echo" }, status: "completed" },
    });

    const approved = await t.respond({ requestId: request.requestId, optionId: "approve" });
    approved.expectOk();
    approved.event("action.result", {
      data: {
        result: { kind: "tool-result", output: new RegExp(GUARDED_ECHO_TOKEN) },
        status: "completed",
      },
      count: 1,
    });

    t.succeeded();
    t.calledTool("guarded-echo", { status: "completed", count: 1 });
  },
});
