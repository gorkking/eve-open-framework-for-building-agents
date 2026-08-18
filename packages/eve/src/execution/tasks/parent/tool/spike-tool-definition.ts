/**
 * Branded `defineTool` wrapper for the spike tool-task fixture. Its
 * authored input schema carries `background` explicitly — the spike
 * answer to per-call launch mode for plain tools; injecting the flag
 * into arbitrary authored schemas stays an open general-surface
 * question (design doc Q8 resolved it for subagents only).
 */

import { z } from "#compiled/zod/index.js";

import {
  executeSpikeToolTaskWorkflow,
  type SpikeToolTaskInput,
} from "#execution/tasks/parent/tool/spike-tool.js";
import { defineTool, type ToolDefinition } from "#public/definitions/tool.js";

export const SPIKE_TOOL_TASK_INPUT_SCHEMA = z.strictObject({
  background: z.boolean().optional(),
  echo: z.string(),
});

export type SpikeToolTask = ToolDefinition<
  SpikeToolTaskInput,
  Awaited<ReturnType<typeof executeSpikeToolTaskWorkflow>>
>;

// Public tools receive a live ToolContext. This spike tool's Workflow is
// started by workflowId through the tool-task executor instead.
export const spikeToolTask: SpikeToolTask = defineTool({
  description: "Spike fixture: echo through a workflow-backed tool task.",
  execute: executeSpikeToolTaskWorkflow as SpikeToolTask["execute"] &
    typeof executeSpikeToolTaskWorkflow,
  inputSchema: SPIKE_TOOL_TASK_INPUT_SCHEMA,
});
