import { defineEval } from "eve/evals";

import { eventIndex, gateLifecycle, GUARDED_ECHO_TOKEN, noEvent } from "./shared";

/**
 * approval-4 + approval-8: a message while an approval is open runs as a normal turn and
 * changes nothing about the request; a later accepted response still restores
 * the assistant-turn approval batch and runs the tool once.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description:
    "approval-4/approval-8: messages never wedge; the approval stays answerable across turns.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-4".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({ display: "confirmation", toolName: "guarded-echo" });

    // approval-4: the message runs as a normal turn; the request is untouched.
    const intervening = await t.send(
      "Ignore the pending approval. Reply with exactly AP4-TURN-OK.",
    );
    intervening.expectOk();
    intervening.messageIncludes(/AP4-TURN-OK/i);
    intervening.eventsSatisfy(
      "no request lifecycle event for the open approval",
      (events) =>
        noEvent(events, "input.responded") &&
        noEvent(events, "input.dismissed") &&
        eventIndex(events, "action.result") === -1,
    );

    // approval-8: the approval settles after the intervening turn; the tool runs once.
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
