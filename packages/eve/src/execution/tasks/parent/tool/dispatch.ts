/**
 * Task-backing for a plain workflow-backed tool: the sibling of
 * `beginDelegatedTask`/`settleDelegatedDispatch` for tools instead of
 * subagents. Shares the same identity derivation and task-run transport;
 * differs in metadata (`kind: "tool"`, operation id as the agent-id
 * surrogate, no agent handle) and in the receipt shape (`tool-result`,
 * so the result key matches the originating tool call).
 */

import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import {
  executeToolTaskWorkflow,
  type ToolTaskWorkflowContext,
  type ToolTaskWorkflowInput,
} from "#execution/tasks/parent/tool/executor.js";
import { startTaskRun, waitForTaskCommandOwner } from "#execution/tasks/parent/run-parent.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import { start } from "#internal/workflow/runtime.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";
import type { JsonObject } from "#shared/json.js";
import { recordSessionTask } from "#tasks/session-index.js";
import { deriveTaskId, deriveTaskInboxToken } from "#tasks/task-id.js";
import type { TaskMetadata } from "#tasks/types.js";

export interface ToolTaskDispatch {
  readonly executorRunId: string;
  readonly receipt: RuntimeActionResult;
  readonly session: RuntimeSession;
  readonly taskId: string;
  readonly taskRunId: string;
}

/**
 * Creates the durable task record, fires the tool's executor Workflow,
 * records the session index entry, and returns the receipt that settles
 * the originating tool call. Must run inside a step body.
 */
export async function dispatchToolTask(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly parentStepIndex?: number;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
  readonly toolInput: JsonObject;
  readonly toolName: string;
  /** The tool's compiled workflow execute function. */
  readonly toolExecute: unknown;
}): Promise<ToolTaskDispatch> {
  const toolWorkflowId = readToolWorkflowId(input.toolExecute, input.toolName);
  const taskId = deriveTaskId({
    callId: input.callId,
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
  });
  const taskInboxToken = deriveTaskInboxToken({
    parentContinuationToken: input.session.continuationToken,
    taskId,
  });
  const operationId = deriveAgentOperationId({
    callId: input.callId,
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
  });
  const metadata: TaskMetadata = {
    agentId: operationId,
    kind: "tool",
    mode: "local",
    name: input.toolName,
  };

  // The task record exists before the executor side effect, so a fast
  // executor always finds a live command hook (create-once, same as the
  // subagent path).
  await startTaskRun({
    initialView: { metadata, status: "working", taskId },
    parentContinuationToken: sessionCommandHookToken(input.session.sessionId),
    taskInboxToken,
  });
  const owner = await waitForTaskCommandOwner({ taskInboxToken });

  const executorRun = await start<
    [ToolTaskWorkflowInput, ToolTaskWorkflowContext],
    { readonly taskId: string }
  >(readToolWorkflowMetadata(executeToolTaskWorkflow), [
    { toolInput: input.toolInput },
    { taskId, taskInboxToken, toolWorkflowId },
  ]);

  return {
    executorRunId: executorRun.runId,
    receipt: {
      callId: input.callId,
      kind: "tool-result",
      output: { status: "working", taskId },
      toolName: input.toolName,
    },
    session: recordSessionTask(input.session, {
      createdByStepIndex: input.parentStepIndex ?? 0,
      createdByTurnId: input.parentTurnId,
      metadata,
      operationId,
      taskId,
      taskInboxToken,
      taskRunId: owner.runId,
    }),
    taskId,
    taskRunId: owner.runId,
  };
}

function readToolWorkflowId(value: unknown, toolName: string): string {
  if (
    typeof value !== "function" ||
    !("workflowId" in value) ||
    typeof value.workflowId !== "string"
  ) {
    throw new Error(`Tool "${toolName}" execute was not compiled as a Workflow function.`);
  }
  return value.workflowId;
}

function readToolWorkflowMetadata(value: unknown): { readonly workflowId: string } {
  return { workflowId: readToolWorkflowId(value, "eve tool-task executor") };
}
