import { z as z3 } from "zod/v3";

import { defineDynamic, defineTool } from "#public/tools/index.js";

export default defineDynamic({
  events: {
    "session.started": (event, ctx) =>
      defineTool({
        description: "Return the active session and trace identifiers.",
        inputSchema: z3.object({ prefix: z3.string() }),
        execute: ({ prefix }) => ({
          sessionId: `${prefix}:${ctx.session.id}`,
          traceId: event.data.trace?.traceId,
        }),
      }),
  },
});
