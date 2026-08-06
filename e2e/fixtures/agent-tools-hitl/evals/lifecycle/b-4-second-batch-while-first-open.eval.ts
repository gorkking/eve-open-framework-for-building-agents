import { defineEval } from "eve/evals";

import { eventIndex, gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

/**
 * B-4: while an approval batch is open, a later turn creates its own input
 * batch. Both stay independently addressable: closing the newer question
 * neither touches the older approval nor replays its batch; the approval
 * still settles and runs afterward.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description: "B-4: later batches coexist with an older open approval batch.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "b-4".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const approval = t.requireInputRequest({ toolName: "guarded-echo" });

    // A later turn raises its own batch while the approval stays open.
    const questionTurn = await t.send(
      "Leave the pending approval alone. Use ask_question to ask me whether to " +
        "proceed, with options yes and no.",
    );
    questionTurn.expectOk();
    const question = t.requireInputRequest({ toolName: "ask_question" });

    // Closing the newer batch leaves the approval untouched.
    const answered = await t.respond({ requestId: question.requestId, optionId: "yes" });
    answered.expectOk();
    answered.eventsSatisfy(
      "closing the question does not touch the approval",
      (events) =>
        eventIndex(events, "input.responded", (data) => data.requestId === approval.requestId) ===
          -1 && eventIndex(events, "input.dismissed") === -1,
    );
    answered.notEvent("action.result", {
      data: { result: { toolName: "guarded-echo" }, status: "completed" },
    });

    // The older approval batch still closes and runs.
    const approved = await t.respond({ requestId: approval.requestId, optionId: "approve" });
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
