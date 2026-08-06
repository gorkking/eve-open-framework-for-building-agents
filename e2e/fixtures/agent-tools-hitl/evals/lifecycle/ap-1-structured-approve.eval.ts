import { defineEval } from "eve/evals";

import { eventBefore, gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

/**
 * AP-1: an accepted Allow response from the originating actor settles the
 * approval, and the tool runs once when that settlement closes its
 * assistant-turn approval batch.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description: "AP-1: structured approve settles the request and runs the tool once.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-1".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({ display: "confirmation", toolName: "guarded-echo" });

    const approved = await t.respond({ requestId: request.requestId, optionId: "approve" });
    approved.expectOk();
    approved.eventsSatisfy("input.responded(allowed) precedes action.result", (events) =>
      eventBefore(
        events,
        {
          type: "input.responded",
          match: (data) => data.requestId === request.requestId && data.outcome === "allowed",
        },
        { type: "action.result" },
      ),
    );
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
