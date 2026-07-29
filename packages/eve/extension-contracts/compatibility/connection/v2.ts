import { defineMcpClientConnection } from "#public/connections/index.js";

export default defineMcpClientConnection({
  approval: () => "user-approval",
  description: "Retain request-time connection approval shorthand",
  url: "https://example.com/mcp",
});
