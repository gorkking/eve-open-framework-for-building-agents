import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "session.started": (event, ctx) =>
      defineInstructions({
        markdown: `Correlate session ${ctx.session.id} with trace ${event.data.trace?.traceId ?? "unavailable"}.`,
      }),
  },
});
