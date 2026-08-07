import { defineEval } from "eve/evals";

import { respondToRequests } from "./delivery";
import {
  exactEventOrder,
  exactRequestActionResult,
  exactRequestExposure,
  exactRequestTerminal,
  noRequestLifecycleEvents,
  requireRequest,
  traceRequest,
} from "./lifecycle";
import { gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

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
        'to ask me whether to continue, with exactly these options: id "yes", label "Yes"; ' +
        'id "no", label "No". Do both in the same response.',
    );
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const approval = requireRequest(parked.inputRequests, {
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const question = requireRequest(parked.inputRequests, {
      optionIds: ["yes", "no"],
      toolName: "ask_question",
    });
    const approvalTrace = traceRequest(parked.events, approval);
    const questionTrace = traceRequest(parked.events, question);

    // approval-18: settle only the approval; the batch stays open behind the question.
    const partial = await respondToRequests(t, {
      requestId: approval.requestId,
      optionId: "approve",
    });
    partial.expectOk();
    partial.eventsSatisfy(
      "approval settles without closing the batch",
      (events) =>
        exactRequestTerminal(events, approvalTrace, {
          type: "responded",
          optionId: "approve",
          outcome: "allowed",
        }) &&
        noRequestLifecycleEvents(events, questionTrace) &&
        exactRequestActionResult(events, approvalTrace, null),
    );
    partial.event("session.waiting", { count: 1 });

    // approval-19: the last request closes the batch; the approved tool runs once.
    const closed = await respondToRequests(t, {
      requestId: question.requestId,
      optionId: "yes",
    });
    closed.expectOk();
    closed.eventsSatisfy(
      "the last response settles once before the approved call executes once",
      (events) =>
        exactRequestTerminal(events, questionTrace, {
          type: "responded",
          optionId: "yes",
          outcome: "answered",
        }) &&
        exactRequestActionResult(events, approvalTrace, {
          output: GUARDED_ECHO_TOKEN,
          status: "completed",
        }) &&
        exactEventOrder(events, [
          { type: "input.responded", requestId: questionTrace.requestId },
          { type: "action.result", actionCallId: approvalTrace.callId },
        ]),
    );
    t.eventsSatisfy(
      "each batch request has one terminal outcome and one allowed action result",
      (events) =>
        exactRequestExposure(events, approvalTrace) &&
        exactRequestExposure(events, questionTrace) &&
        exactRequestTerminal(events, approvalTrace, {
          type: "responded",
          optionId: "approve",
          outcome: "allowed",
        }) &&
        exactRequestTerminal(events, questionTrace, {
          type: "responded",
          optionId: "yes",
          outcome: "answered",
        }) &&
        exactRequestActionResult(events, approvalTrace, {
          output: GUARDED_ECHO_TOKEN,
          status: "completed",
        }),
    );

    closed.succeeded();
    t.succeeded();
    t.calledTool("guarded-echo", { status: "completed", count: 1 });
  },
});
