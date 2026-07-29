import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": () => ({
      inspect: defineTool({
        approval: () => "user-approval",
        description: "Retain dynamic request-time approval shorthand",
        inputSchema: { type: "object", properties: {} },
        execute: async () => ({ ok: true }),
      }),
    }),
  },
});
