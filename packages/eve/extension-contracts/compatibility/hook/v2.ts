import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "input.requested"(event, ctx) {
      console.info("input requested", event.data.requests.length, ctx.session.id);
    },
  },
});
