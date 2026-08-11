import { defineHook } from "#public/hooks/index.js";

export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      const sandbox = await ctx.getSandbox();
      await sandbox.setNetworkPolicy("deny-all");
      console.info("locked down sandbox egress", {
        sandboxId: sandbox.id,
        sessionId: ctx.session.id,
      });
    },
  },
});
