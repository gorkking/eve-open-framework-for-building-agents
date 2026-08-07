import { defineEval } from "eve/evals";

import { eventBefore, gateLifecycle } from "./shared";

/**
 * question-4: an accepted answer plus a message in one delivery — the answer settles
 * the question (supersession does not run), then the message runs.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description: "question-4: compound answer+message settles the question, then runs the message.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send(
      "Use ask_question to ask me whether to use red or blue, with options red and blue.",
    );
    const request = t.requireInputRequest({ toolName: "ask_question" });

    const compound = await t.send({
      inputResponses: [{ requestId: request.requestId, optionId: "red" }],
      message: "After recording my answer, reply with exactly Q4-COMPOUND-OK.",
    });
    compound.expectOk();
    compound.eventsSatisfy("the answer settles before the message", (events) =>
      eventBefore(
        events,
        {
          type: "input.responded",
          match: (data) => data.requestId === request.requestId && data.outcome === "answered",
        },
        { type: "message.received" },
      ),
    );
    compound.messageIncludes(/Q4-COMPOUND-OK/i);

    t.succeeded();
  },
});
