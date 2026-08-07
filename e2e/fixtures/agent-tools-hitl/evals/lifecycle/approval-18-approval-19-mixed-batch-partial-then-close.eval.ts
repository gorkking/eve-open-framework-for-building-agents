import { defineEval } from "eve/evals";

import { eventIndex, gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

/**
 * approval-18 + approval-19: one assistant turn creates an approval and a question in the
 * same assistant-turn input batch. Settling one request leaves the batch
 * pending and runs nothing; settling the last request restores the stored
 * model output once and runs the approved tool exactly once.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description:
    "approval-18/approval-19: batch stays pending on partial settlement; last outcome closes it.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send(
      'In one single turn, call the guarded-echo tool with note "b-1" AND use ask_question ' +
        "to ask me whether to continue, with options yes and no. Do both in the same response.",
    );
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const approval = t.requireInputRequest({ toolName: "guarded-echo" });
    const question = t.requireInputRequest({ toolName: "ask_question" });

    // approval-18: settle only the approval; the batch stays open behind the question.
    const partial = await t.respond({ requestId: approval.requestId, optionId: "approve" });
    partial.expectOk();
    partial.eventsSatisfy(
      "approval settles without closing the batch",
      (events) =>
        eventIndex(events, "input.responded", (data) => data.requestId === approval.requestId) >=
          0 && eventIndex(events, "action.result") === -1,
    );

    // approval-19: the last request closes the batch; the approved tool runs once.
    const closed = await t.respond({ requestId: question.requestId, optionId: "yes" });
    closed.expectOk();
    closed.event("action.result", {
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
