import { z } from "#compiled/zod/index.js";

import { reportProgress } from "#execution/report-progress.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";

export const REPORT_PROGRESS_TOOL_NAME = "report_progress";

export const REPORT_PROGRESS_TOOL: HarnessToolDefinition = {
  description: "Report brief current activity to the configured channel.",
  execute: async (input: { readonly message: unknown }, options) =>
    await reportProgress({ callId: options.toolCallId, message: input.message }),
  inputSchema: z.strictObject({
    message: z.string().min(1).describe("Brief description of the work currently in progress."),
  }),
  name: REPORT_PROGRESS_TOOL_NAME,
};
