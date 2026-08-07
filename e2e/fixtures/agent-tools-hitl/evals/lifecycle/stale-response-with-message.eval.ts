import { defineEval } from "eve/evals";

import { respondToRequests, sendCompoundDelivery } from "./delivery";
import {
  exactEventOrder,
  exactRequestActionResult,
  exactRequestRejection,
  exactRequestTerminal,
  traceRequest,
} from "./lifecycle";
import { gateLifecycle } from "./shared";

/**
 * approval-10: a stale response and a message in one delivery — the rejection is
 * explicit and precedes the message, which still runs as a normal turn.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description: "approval-10: stale response is rejected; the co-delivered message still runs.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-10".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const trace = traceRequest(parked.events, request);

    const denied = await respondToRequests(t, {
      requestId: request.requestId,
      optionId: "deny",
    });
    denied.expectOk();
    denied.eventsSatisfy(
      "denial closes the request without executing",
      (events) =>
        exactRequestTerminal(events, trace, {
          type: "responded",
          optionId: "deny",
          outcome: "denied",
        }) && exactRequestActionResult(events, trace, { status: "rejected" }),
    );

    const compound = await sendCompoundDelivery(t, {
      inputResponses: [{ requestId: request.requestId, optionId: "approve" }],
      message: "Reply with exactly AP10-MSG-OK.",
    });
    compound.expectOk();
    compound.eventsSatisfy(
      "one stale rejection precedes the message and no stale action runs",
      (events) =>
        exactRequestRejection(events, trace, "stale") &&
        exactRequestActionResult(events, trace, null) &&
        exactEventOrder(events, [
          { type: "input.response.rejected", requestId: trace.requestId },
          { type: "message.received" },
        ]),
    );
    compound.messageIncludes(/AP10-MSG-OK/i);
    compound.succeeded();
  },
});
