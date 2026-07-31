import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    "subagent.completed"(event) {
      console.info("subagent completed", event.data.subagentName, event.data.callId);
    },
  },
});
