import type {
  RuntimeActionDispatchInput,
  RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import {
  type LocalSubagentWorkflowContext,
  type LocalSubagentWorkflowEntry,
  type LocalSubagentWorkflowInput,
  type LocalSubagentWorkflowTool,
} from "#execution/tasks/parent/subagent/local.js";
import {
  type RemoteSubagentWorkflowContext,
  type RemoteSubagentWorkflowEntry,
  type RemoteSubagentWorkflowInput,
  type RemoteSubagentWorkflowTool,
} from "#execution/tasks/parent/subagent/remote.js";
import { start, type WorkflowMetadata } from "#internal/workflow/runtime.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";

export interface SubagentWorkflowDispatch {
  readonly result: RuntimeActionDispatchResult;
  readonly workflowRunId: string;
}

/** Starts the local subagent definition's Workflow executor. */
export async function dispatchLocalSubagentWorkflow(input: {
  readonly entry: LocalSubagentWorkflowEntry;
  readonly fanoutSize: number;
  readonly runtimeInput: RuntimeActionDispatchInput;
  readonly tool: LocalSubagentWorkflowTool;
}): Promise<SubagentWorkflowDispatch> {
  const action = input.entry.kind === "resume" ? input.entry.action : input.entry.target.action;
  const run = await start<
    [LocalSubagentWorkflowInput, LocalSubagentWorkflowContext],
    RuntimeActionDispatchResult
  >(readWorkflowMetadata(input.tool.execute, "Local"), [
    PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA.parse(action.input),
    {
      entry: input.entry,
      fanoutSize: input.fanoutSize,
      runtimeInput: input.runtimeInput,
    },
  ]);

  return { result: await run.returnValue, workflowRunId: run.runId };
}

/** Starts the remote subagent definition's Workflow executor. */
export async function dispatchRemoteSubagentWorkflow(input: {
  readonly entry: RemoteSubagentWorkflowEntry;
  readonly fanoutSize: number;
  readonly runtimeInput: RuntimeActionDispatchInput;
  readonly tool: RemoteSubagentWorkflowTool;
}): Promise<SubagentWorkflowDispatch> {
  const action = input.entry.kind === "resume" ? input.entry.action : input.entry.target.action;
  const run = await start<
    [RemoteSubagentWorkflowInput, RemoteSubagentWorkflowContext],
    RuntimeActionDispatchResult
  >(readWorkflowMetadata(input.tool.execute, "Remote"), [
    PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA.parse(action.input),
    {
      entry: input.entry,
      fanoutSize: input.fanoutSize,
      runtimeInput: input.runtimeInput,
    },
  ]);

  return { result: await run.returnValue, workflowRunId: run.runId };
}

function readWorkflowMetadata(value: unknown, label: "Local" | "Remote"): WorkflowMetadata {
  if (
    typeof value !== "function" ||
    !("workflowId" in value) ||
    typeof value.workflowId !== "string"
  ) {
    throw new Error(`${label} subagent tool executor was not compiled as a Workflow function.`);
  }
  return { workflowId: value.workflowId };
}
