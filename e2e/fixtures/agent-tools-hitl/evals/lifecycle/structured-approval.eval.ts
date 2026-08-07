import { defineEval } from "eve/evals";

import { respondToRequests } from "./delivery";
import {
  exactEventOrder,
  exactRequestActionResult,
  exactRequestTerminal,
  traceRequest,
} from "./lifecycle";
import { gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

/**
 * approval-1: an accepted Allow response from the originating actor settles the
 * approval, and the tool runs once when that settlement closes its
 * assistant-turn approval batch.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description: "approval-1: structured approve settles the request and runs the tool once.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-1".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({
      display: "confirmation",
      optionIds: ["approve", "deny"],
      toolName: "guarded-echo",
    });
    const trace = traceRequest(parked.events, request);

    const approved = await respondToRequests(t, {
      requestId: request.requestId,
      optionId: "approve",
    });
    approved.expectOk();
    approved.eventsSatisfy(
      "one allowed terminal precedes its one action result",
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
    approved.calledTool("guarded-echo", {
      input: { note: "ap-1" },
      output: new RegExp(GUARDED_ECHO_TOKEN),
      status: "completed",
      count: 1,
    });

    approved.succeeded();
    t.succeeded();
    t.calledTool("guarded-echo", { status: "completed", count: 1 });
  },
});
