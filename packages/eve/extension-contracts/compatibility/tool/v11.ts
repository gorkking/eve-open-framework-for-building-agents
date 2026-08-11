import { z as z3 } from "zod/v3";

import { defineTool } from "#public/tools/index.js";

export default defineTool({
  description: "Fetch a document with egress narrowed to one host.",
  inputSchema: z3.object({ url: z3.string() }),
  async execute({ url }, ctx) {
    const sandbox = await ctx.getSandbox();
    await sandbox.setNetworkPolicy({ allow: { "docs.example.com": [] } });
    const result = await sandbox.run({ command: `curl -sS ${url}` });
    await sandbox.setNetworkPolicy("deny-all");
    return { body: result.stdout, callId: ctx.callId };
  },
});
