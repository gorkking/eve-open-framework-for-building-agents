import { defineEval } from "eve/evals";

import { eventBefore, gateLifecycle } from "./shared";

/**
 * AP-10: a stale response and a message in one delivery — the rejection is
 * explicit and precedes the message, which still runs as a normal turn.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description: "AP-10: stale response is rejected; the co-delivered message still runs.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-10".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({ display: "confirmation", toolName: "guarded-echo" });

    const denied = await t.respond({ requestId: request.requestId, optionId: "deny" });
    denied.expectOk();

    const compound = await t.send({
      inputResponses: [{ requestId: request.requestId, optionId: "approve" }],
      message: "Reply with exactly AP10-MSG-OK.",
    });
    compound.expectOk();
    compound.eventsSatisfy("stale rejection precedes the message", (events) =>
      eventBefore(
        events,
        {
          type: "input.response.rejected",
          match: (data) => data.requestId === request.requestId && data.reason === "stale",
        },
        { type: "message.received" },
      ),
    );
    compound.messageIncludes(/AP10-MSG-OK/i);
    compound.notEvent("action.result", {
      data: { result: { toolName: "guarded-echo" }, status: "completed" },
    });
  },
});
