import { defineEval } from "eve/evals";

import { eventBefore, gateLifecycle } from "./shared";

/**
 * Q-2: a message from the question's originating actor supersedes the
 * question — dismissed, then the message runs as a normal turn. The typed
 * text is handled semantically by the agent, never matched by the runtime.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description: "Q-2: the originating actor's message supersedes their open question.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send(
      "Use ask_question to ask me whether to use red or blue, with options red and blue.",
    );
    const request = t.requireInputRequest({ toolName: "ask_question" });

    const superseded = await t.send("Skip the question. Reply with exactly Q2-SUPERSEDE-OK.");
    superseded.expectOk();
    superseded.eventsSatisfy("dismissal precedes the message", (events) =>
      eventBefore(
        events,
        {
          type: "input.dismissed",
          match: (data) => data.requestId === request.requestId && data.reason === "superseded",
        },
        { type: "message.received" },
      ),
    );
    superseded.messageIncludes(/Q2-SUPERSEDE-OK/i);

    t.succeeded();
  },
});
