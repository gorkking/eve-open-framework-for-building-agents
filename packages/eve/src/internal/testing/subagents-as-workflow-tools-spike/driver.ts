import { resumeHook, start, type WorkflowMetadata } from "#internal/workflow/runtime.js";
import { waitForHook } from "#internal/testing/workflow-test-helpers.js";
import type { JsonValue } from "#shared/json.js";

import {
  WORKFLOW_SUBAGENT_TARGET,
  runLocalPrototypeSubagent,
  runRemotePrototypeSubagent,
  type PrototypeSubagentEnvelope,
  type PrototypeSubagentExecutorInput,
  type SubagentToolInput,
  type SubagentWorkflowInvocationContext,
  type WorkflowBackedSubagentTool,
  type WorkflowBackedTool,
  type WorkflowToolInvocationContext,
} from "./prototype.js";

export interface WorkflowToolDispatchInput {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly toolName: string;
}

export interface WorkflowToolDispatch<TOutput> {
  readonly result: Promise<TOutput>;
  readonly runId: string;
}

export interface SubagentWorkflowToolDispatch extends WorkflowToolDispatch<JsonValue> {
  readonly executorResult: Promise<JsonValue>;
  readonly executorRunId: string;
  readonly inputRequestId: string;
  respond(value: JsonValue): Promise<void>;
}

/** Starts a workflow-backed defineTool value through its compiler-assigned workflowId. */
export async function dispatchWorkflowTool<TInput, TOutput>(
  tool: WorkflowBackedTool<TInput, WorkflowToolInvocationContext, TOutput>,
  input: TInput,
  invocation: WorkflowToolDispatchInput,
): Promise<WorkflowToolDispatch<TOutput>> {
  const run = await start<[TInput, WorkflowToolInvocationContext], TOutput>(
    readWorkflowMetadata(tool.execute),
    [input, invocation],
  );

  return { result: run.returnValue, runId: run.runId };
}

/**
 * Test-only dispatcher proving the complete two-run subagent tool lifecycle.
 * It selects the executor from private tool metadata, never model input.
 */
export async function dispatchSubagentWorkflowTool(
  tool: WorkflowBackedSubagentTool,
  input: SubagentToolInput,
  invocation: WorkflowToolDispatchInput,
): Promise<SubagentWorkflowToolDispatch> {
  const target = tool[WORKFLOW_SUBAGENT_TARGET];
  const tokenPrefix = `eve:spike:${invocation.parentSessionId}:${invocation.callId}`;
  const workflowInboxToken = `${tokenPrefix}:workflow`;
  const subagentInboxToken = `${tokenPrefix}:executor`;
  const context: SubagentWorkflowInvocationContext = {
    ...invocation,
    subagentInboxToken,
    target,
    workflowInboxToken,
  };
  const toolRun = await start<[SubagentToolInput, SubagentWorkflowInvocationContext], JsonValue>(
    readWorkflowMetadata(tool.execute),
    [input, context],
  );
  await waitForHook(toolRun, { token: workflowInboxToken });

  const executor = target.kind === "local" ? runLocalPrototypeSubagent : runRemotePrototypeSubagent;
  const executorRun = await start<[PrototypeSubagentExecutorInput], JsonValue>(
    readWorkflowMetadata(executor),
    [{ input, subagentInboxToken, target, workflowInboxToken }],
  );
  await waitForHook(executorRun, { token: subagentInboxToken });

  return {
    executorResult: executorRun.returnValue,
    executorRunId: executorRun.runId,
    inputRequestId: `${subagentInboxToken}:approval`,
    respond: async (value) => {
      const envelope: PrototypeSubagentEnvelope = {
        kind: "input.response",
        requestId: `${subagentInboxToken}:approval`,
        value,
      };
      await resumeHook(workflowInboxToken, envelope);
    },
    result: toolRun.returnValue,
    runId: toolRun.runId,
  };
}

function readWorkflowMetadata(value: unknown): WorkflowMetadata {
  if (
    typeof value !== "function" ||
    !("workflowId" in value) ||
    typeof value.workflowId !== "string"
  ) {
    throw new Error("Expected a compiler-transformed workflow function.");
  }

  return { workflowId: value.workflowId };
}
