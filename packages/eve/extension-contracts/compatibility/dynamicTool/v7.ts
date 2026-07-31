import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": () =>
      defineTool({
        description: "Report the latest deployment status.",
        inputSchema: { type: "object", properties: {} },
        execute: () => ({ deployment: "healthy" }),
      }),
  },
});
