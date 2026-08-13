import { defineDynamic, defineSkill } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "turn.started": (event, ctx) =>
      defineSkill({
        description: `Review evidence for session ${ctx.session.id}.`,
        markdown: `# Evidence review\n\nTrace: ${event.data.trace?.traceId ?? "unavailable"}`,
      }),
  },
});
