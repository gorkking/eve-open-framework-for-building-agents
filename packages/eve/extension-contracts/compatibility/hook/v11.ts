import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "approval.candidate"(event, ctx) {
      console.info("approval candidate", {
        candidateId: event.data.candidateId,
        outcome: event.data.outcome,
        sessionId: ctx.session.id,
      });
    },
  },
});
