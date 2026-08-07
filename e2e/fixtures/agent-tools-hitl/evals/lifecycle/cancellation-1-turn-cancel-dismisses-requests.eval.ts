import { defineEval } from "eve/evals";

import { eventBefore, gateLifecycle } from "./shared";

/**
 * cancellation-1: cancelling the owning turn dismisses its open requests as
 * `cancelled` before the cancellation boundary, and never restores the batch
 * or runs the gated tool.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description: "cancellation-1: turn cancellation dismisses the turn's open requests.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "cancellation-1".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({ display: "confirmation", toolName: "guarded-echo" });

    await t.cancel();
    await t.sleep();

    t.eventsSatisfy("dismissal precedes the cancellation boundary", (events) =>
      eventBefore(
        events,
        {
          type: "input.dismissed",
          match: (data) => data.requestId === request.requestId && data.reason === "cancelled",
        },
        { type: "turn.cancelled" },
      ),
    );
    t.notCalledTool("guarded-echo-completed-never");
    t.eventsSatisfy("the gated tool never completed", (events) =>
      events.every((event) => {
        const candidate = event as { type?: string; data?: { status?: string } };
        return !(candidate.type === "action.result" && candidate.data?.status === "completed");
      }),
    );
  },
});
