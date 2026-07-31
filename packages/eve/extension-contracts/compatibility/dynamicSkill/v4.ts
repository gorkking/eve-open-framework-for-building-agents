import { defineDynamic, defineSkill } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineSkill({
        description: "Summarize what changed during the turn.",
        markdown: "# Recap\n\nList the actions taken this turn.",
      }),
  },
});
