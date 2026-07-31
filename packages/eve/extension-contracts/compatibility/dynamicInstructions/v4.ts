import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineInstructions({
        markdown: "Cite the tool results you relied on this turn.",
      }),
  },
});
