import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  description: "Wait for the requested reporting-probe delay.",
  inputSchema: z.strictObject({
    delayMs: z.number().int().min(1).max(180_000),
  }),
  async execute({ delayMs }) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    return { waitedMs: delayMs };
  },
});
