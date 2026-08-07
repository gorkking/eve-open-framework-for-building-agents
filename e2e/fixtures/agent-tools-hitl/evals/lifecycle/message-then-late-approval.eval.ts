import { defineEval } from "eve/evals";

import { respondToRequests } from "./delivery";
import {
  exactEventOrder,
  exactRequestActionResult,
  exactRequestTerminal,
  expectFollowUpSessionActive,
  noRequestLifecycleEvents,
  traceRequest,
} from "./lifecycle";
import { gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

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
    const request = t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const trace = traceRequest(parked.events, request);

    // approval-4: the message runs as a normal turn; the request is untouched.
    const intervening = await t.send(
      "Ignore the pending approval. Reply with exactly AP4-TURN-OK.",
    );
    intervening.expectOk();
    expectFollowUpSessionActive(intervening, parked.sessionId);
    intervening.messageIncludes(/AP4-TURN-OK/i);
    intervening.event("message.received", { count: 1 });
    intervening.eventsSatisfy(
      "no request lifecycle event for the open approval",
      (events) =>
        noRequestLifecycleEvents(events, trace) && exactRequestActionResult(events, trace, null),
    );

    // approval-8: the approval settles after the intervening turn; the tool runs once.
    const approved = await respondToRequests(t, {
      requestId: request.requestId,
      optionId: "approve",
    });
    approved.expectOk();
    expectFollowUpSessionActive(approved, parked.sessionId);
    approved.eventsSatisfy(
      "late approval settles and runs its original call once",
      (events) =>
        exactRequestTerminal(events, trace, {
          type: "responded",
          optionId: "approve",
          outcome: "allowed",
        }) &&
        exactRequestActionResult(events, trace, {
          output: GUARDED_ECHO_TOKEN,
          status: "completed",
        }) &&
        exactEventOrder(events, [
          { type: "input.responded", requestId: trace.requestId },
          { type: "action.result", actionCallId: trace.callId },
        ]),
    );
    t.eventsSatisfy("the intervening turn stays before restored batch work", (events) =>
      exactEventOrder(events, [
        {
          type: "message.received",
          match: (data) => typeof data.message === "string" && data.message.includes("AP4-TURN-OK"),
        },
        { type: "input.responded", requestId: trace.requestId },
        { type: "action.result", actionCallId: trace.callId },
      ]),
    );

    approved.succeeded();
    t.succeeded();
    t.calledTool("guarded-echo", { status: "completed", count: 1 });
  },
});
