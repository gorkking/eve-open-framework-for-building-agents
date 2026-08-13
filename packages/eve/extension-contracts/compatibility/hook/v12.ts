import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "session.started"(event, ctx) {
      console.info("session started", {
        sessionId: ctx.session.id,
        traceId: event.data.trace?.traceId,
      });
    },
  },
});
