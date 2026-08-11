import { z as z3 } from "zod/v3";

import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": (_event, ctx) => ({
      snapshot_workspace: defineTool({
        description: "List the workspace with egress locked down.",
        inputSchema: z3.object({ path: z3.string() }),
        async execute({ path }, toolContext) {
          const sandbox = await toolContext.getSandbox();
          await sandbox.setNetworkPolicy("deny-all");
          const result = await sandbox.run({ command: `ls -la ${path}` });
          return { listing: result.stdout, sessionId: ctx.session.id };
        },
      }),
    }),
  },
});
