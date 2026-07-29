import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineInstructions({
        markdown: "Retain dynamic instructions authoring.",
      }),
  },
});
