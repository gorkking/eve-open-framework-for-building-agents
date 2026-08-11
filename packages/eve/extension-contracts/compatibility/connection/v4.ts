import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  description: "Session-scoped MCP service",
  headers: { "X-Api-Key": "example" },
  toolCall: {
    providedArguments: {
      sessionId: ({ session }) => session.id,
    },
  },
  tools: { allow: ["search"] },
  url: "https://example.com/mcp",
});
