import { z } from "#compiled/zod/index.js";
import type { RuntimeActionDispatchResult } from "#execution/dispatch-runtime-actions-shared.js";
import type { ToolDefinition } from "#public/definitions/tool.js";
import { defineTool } from "#public/definitions/tool.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";

export type SubagentWorkflowInput = z.infer<typeof PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA>;

export type SubagentWorkflowTool<TContext> = Omit<
  ToolDefinition<SubagentWorkflowInput, RuntimeActionDispatchResult>,
  "execute"
> & {
  readonly execute: (
    input: SubagentWorkflowInput,
    context: TContext,
  ) => Promise<RuntimeActionDispatchResult>;
};

export function defineSubagentWorkflowTool<TContext>(input: {
  readonly description: string;
  readonly execute: SubagentWorkflowTool<TContext>["execute"];
}): SubagentWorkflowTool<TContext> {
  // Public tools receive a live ToolContext. These framework-owned Workflow
  // executors are started by workflowId with a serializable private context;
  // keep that internal ABI adaptation at the definition boundary.
  return defineTool({
    description: input.description,
    execute: input.execute as ToolDefinition<
      SubagentWorkflowInput,
      RuntimeActionDispatchResult
    >["execute"],
    inputSchema: PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA,
  }) as SubagentWorkflowTool<TContext>;
}
