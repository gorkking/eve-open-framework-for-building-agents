import {
  executeRemoteSubagentWorkflow,
  type RemoteSubagentWorkflowInput,
} from "#execution/tasks/parent/subagent/remote.js";
import type { ToolDefinition } from "#public/definitions/tool.js";
import { defineTool } from "#public/definitions/tool.js";
import { TASK_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";

export type RemoteSubagentWorkflowTool = ToolDefinition<
  RemoteSubagentWorkflowInput,
  Awaited<ReturnType<typeof executeRemoteSubagentWorkflow>>
>;

// Public tools receive a live ToolContext. This framework-owned Workflow is
// started by workflowId with a serializable private context.
export const remoteSubagentWorkflowTool: RemoteSubagentWorkflowTool = defineTool({
  description: "Dispatch a remote subagent as a durable background task.",
  execute: executeRemoteSubagentWorkflow as RemoteSubagentWorkflowTool["execute"] &
    typeof executeRemoteSubagentWorkflow,
  inputSchema: TASK_SUBAGENT_TOOL_INPUT_SCHEMA,
});
