import { defineEval } from "eve/evals";

import { eventBefore, gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

/**
 * approval-7: one delivery carrying an accepted response plus a message is
 * serialized — settlement, restored batch output, tool result, then the
 * message as ordinary turn input. Each part happens exactly once.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description: "approval-7: compound response+message settles first, then runs the message.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-7".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({ display: "confirmation", toolName: "guarded-echo" });

    const compound = await t.send({
      inputResponses: [{ requestId: request.requestId, optionId: "approve" }],
      message: "After the tool result, reply with exactly AP7-COMPOUND-OK.",
    });
    compound.expectOk();
    compound.eventsSatisfy("settlement precedes the message", (events) =>
      eventBefore(
        events,
        { type: "input.responded", match: (data) => data.requestId === request.requestId },
        { type: "message.received" },
      ),
    );
    compound.event("action.result", {
      data: {
        result: { kind: "tool-result", output: new RegExp(GUARDED_ECHO_TOKEN) },
        status: "completed",
      },
      count: 1,
    });
    compound.messageIncludes(/AP7-COMPOUND-OK/i);

    t.succeeded();
    t.calledTool("guarded-echo", { status: "completed", count: 1 });
  },
});
