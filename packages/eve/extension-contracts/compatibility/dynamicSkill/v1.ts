import { defineDynamic, defineSkill } from "#public/skills/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineSkill({
        description: "Retain dynamic skill authoring",
        markdown: "# Retained skill",
      }),
  },
});
