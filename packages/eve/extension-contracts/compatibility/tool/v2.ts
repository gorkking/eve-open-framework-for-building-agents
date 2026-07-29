import { defineTool } from "#public/tools/index.js";

export default defineTool({
  approval: ({ toolInput }) => (toolInput?.confirmed === true ? "not-applicable" : "user-approval"),
  description: "Retain request-time approval function shorthand",
  inputSchema: { type: "object", properties: { confirmed: { type: "boolean" } } },
  async execute(input, ctx) {
    return { input, sessionId: ctx.session.id };
  },
});
