import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Keep a fanout task active long enough to exercise its parent session.",
  inputSchema: z.object({ milliseconds: z.literal(3_000) }),
  async execute({ milliseconds }) {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    return { heldMilliseconds: milliseconds };
  },
});
