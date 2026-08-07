import { defineEval } from "eve/evals";

import { invokeCallback, sendAs, verifyFollowUp } from "./shared";

const TOKEN = "interactive-auth-token-H6P3";

export default defineEval({
  tags: ["real-model"],
  description:
    "Interactive authorization callback resumes the blocked tool and keeps the session active.",
  async test(t) {
    const parked = await sendAs(
      t,
      'Call auth-probe exactly once with marker "callback-ok". Include its token verbatim.',
      "A",
    );
    parked.event("authorization.required", { count: 1 });
    parked.notEvent("authorization.completed");
    parked.event("session.waiting", { count: 1 });

    const resumed = await invokeCallback(t, parked);
    resumed.turn.expectOk();
    resumed.turn.eventOrder([
      { type: "authorization.completed", count: 1 },
      {
        type: "action.result",
        data: { result: { toolName: "auth-probe" }, status: "completed" },
        count: 1,
      },
    ]);
    resumed.turn.event("authorization.completed", {
      data: { outcome: "authorized" },
      count: 1,
    });
    resumed.turn.calledTool("auth-probe", {
      output: { actor: "e2e-hitl-a", marker: "callback-ok", token: TOKEN },
      count: 1,
    });
    resumed.turn.messageIncludes(TOKEN);

    await verifyFollowUp(resumed.session, parked.sessionId, "AUTH-CALLBACK-FOLLOW-UP-OK");
  },
});
