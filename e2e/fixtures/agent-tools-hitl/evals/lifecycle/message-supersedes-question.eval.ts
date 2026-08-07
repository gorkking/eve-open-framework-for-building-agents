import { defineEval } from "eve/evals";

import {
  exactEventOrder,
  exactRequestTerminal,
  expectFollowUpSessionActive,
  traceRequest,
} from "./lifecycle";
import { gateLifecycle } from "./shared";

/**
 * question-2: a message from the question's originating actor supersedes the
 * question — dismissed, then the message runs as a normal turn. The typed
 * text is handled semantically by the agent, never matched by the runtime.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description: "question-2: the originating actor's message supersedes their open question.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send(
      'Use ask_question to ask whether to use red or blue with exactly these options: id "red", ' +
        'label "Red"; id "blue", label "Blue".',
    );
    const request = t.requireInputRequest({
      optionIds: ["red", "blue"],
      toolName: "ask_question",
    });
    const trace = traceRequest(parked.events, request);

    const superseded = await t.send("Skip the question. Reply with exactly Q2-SUPERSEDE-OK.");
    superseded.expectOk();
    expectFollowUpSessionActive(superseded, parked.sessionId);
    superseded.eventsSatisfy(
      "one supersession terminal precedes the message",
      (events) =>
        exactRequestTerminal(events, trace, {
          type: "dismissed",
          reason: "superseded",
        }) &&
        exactEventOrder(events, [
          { type: "input.dismissed", requestId: trace.requestId },
          { type: "message.received" },
        ]),
    );
    superseded.messageIncludes(/Q2-SUPERSEDE-OK/i);

    superseded.succeeded();
    t.succeeded();
  },
});
