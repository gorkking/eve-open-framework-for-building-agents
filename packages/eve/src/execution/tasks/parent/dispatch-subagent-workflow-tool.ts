import { start, type WorkflowMetadata } from "#internal/workflow/runtime.js";

import type {
  RuntimeActionDispatchInput,
  RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import {
  SUBAGENT_WORKFLOW_TOOL_CONTEXT_KIND,
  subagentWorkflowTool,
  type SubagentWorkflowToolContext,
  type SubagentWorkflowToolEntry,
  type SubagentWorkflowToolInput,
} from "#execution/tasks/parent/subagent-workflow-tool.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";

export interface SubagentWorkflowToolDispatch {
  readonly result: RuntimeActionDispatchResult;
  readonly workflowRunId: string;
}

/** Starts one production subagent tool call as its own Workflow run. */
export async function dispatchSubagentWorkflowTool(input: {
  readonly entry: SubagentWorkflowToolEntry;
  readonly fanoutSize: number;
  readonly runtimeInput: RuntimeActionDispatchInput;
}): Promise<SubagentWorkflowToolDispatch> {
  const action = input.entry.kind === "resume" ? input.entry.action : input.entry.target.action;
  const run = await start<
    [SubagentWorkflowToolInput, SubagentWorkflowToolContext],
    RuntimeActionDispatchResult
  >(readWorkflowMetadata(subagentWorkflowTool.execute), [
    PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA.parse(action.input),
    {
      entry: input.entry,
      fanoutSize: input.fanoutSize,
      kind: SUBAGENT_WORKFLOW_TOOL_CONTEXT_KIND,
      runtimeInput: input.runtimeInput,
    },
  ]);

  return { result: await run.returnValue, workflowRunId: run.runId };
}

function readWorkflowMetadata(value: unknown): WorkflowMetadata {
  if (
    typeof value !== "function" ||
    !("workflowId" in value) ||
    typeof value.workflowId !== "string"
  ) {
    throw new Error("Subagent workflow tool executor was not compiled as a Workflow function.");
  }
  return { workflowId: value.workflowId };
}
