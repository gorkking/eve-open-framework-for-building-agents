import {
  executeLocalSubagentWorkflow,
  type LocalSubagentWorkflowInput,
} from "#execution/tasks/parent/subagent/local.js";
import type { ToolDefinition } from "#public/definitions/tool.js";
import { defineTool } from "#public/definitions/tool.js";
import { TASK_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";

export type LocalSubagentWorkflowTool = ToolDefinition<
  LocalSubagentWorkflowInput,
  Awaited<ReturnType<typeof executeLocalSubagentWorkflow>>
>;

// Public tools receive a live ToolContext. This framework-owned Workflow is
// started by workflowId with a serializable private context.
export const localSubagentWorkflowTool: LocalSubagentWorkflowTool = defineTool({
  description: "Dispatch a local subagent as a durable background task.",
  execute: executeLocalSubagentWorkflow as LocalSubagentWorkflowTool["execute"] &
    typeof executeLocalSubagentWorkflow,
  inputSchema: TASK_SUBAGENT_TOOL_INPUT_SCHEMA,
});
