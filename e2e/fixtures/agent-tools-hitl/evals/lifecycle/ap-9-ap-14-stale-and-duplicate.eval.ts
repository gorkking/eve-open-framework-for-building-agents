import { defineEval } from "eve/evals";

import { eventIndex, gateLifecycle, GUARDED_ECHO_TOKEN } from "./shared";

/**
 * AP-9 + AP-14: a response referencing a closed request is stale — it changes
 * no request and never executes the tool, and the agent still initiates a
 * turn with the stale-attempt context.
 */
export default defineEval({
  tags: ["real-model", "hitl-lifecycle"],
  description:
    "AP-9/AP-14: responses after closure are stale; no second adjudication or execution.",
  async test(t) {
    gateLifecycle(t);

    const parked = await t.send('Call the guarded-echo tool with note "ap-9".');
    parked.calledTool("guarded-echo", { status: "pending", count: 1 });
    const request = t.requireInputRequest({ display: "confirmation", toolName: "guarded-echo" });

    const denied = await t.respond({ requestId: request.requestId, optionId: "deny" });
    denied.expectOk();
    denied.eventsSatisfy(
      "denial settles the request",
      (events) =>
        eventIndex(
          events,
          "input.responded",
          (data) => data.requestId === request.requestId && data.outcome === "denied",
        ) >= 0,
    );

    // AP-9/AP-14: the late approve is stale — rejected, no execution, and the
    // agent runs a turn with the stale-attempt context.
    const stale = await t.send({
      inputResponses: [{ requestId: request.requestId, optionId: "approve" }],
    });
    stale.expectOk();
    stale.eventsSatisfy(
      "stale rejection is explicit",
      (events) =>
        eventIndex(
          events,
          "input.response.rejected",
          (data) => data.requestId === request.requestId && data.reason === "stale",
        ) >= 0,
    );
    stale.notEvent("action.result", {
      data: { result: { toolName: "guarded-echo" }, status: "completed" },
    });

    t.notCalledTool("guarded-echo-completed-never");
    t.calledTool("guarded-echo", { status: "rejected", count: 1 });
    t.eventsSatisfy(
      "the denied tool never produced a completed result",
      (events) =>
        eventIndex(events, "action.result", (data) => {
          const result = data.result as { output?: unknown } | undefined;
          return typeof result?.output === "string" && result.output.includes(GUARDED_ECHO_TOKEN);
        }) === -1,
    );
  },
});
