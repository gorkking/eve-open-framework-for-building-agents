/**
 * Durable executor for one tool-backed task: a framework-owned Workflow
 * run that owns the authored tool's execution the way a child session
 * owns a subagent's. It starts the tool's own compiled Workflow, awaits
 * its return value, and reports the terminal outcome to the task run's
 * inbox — the task run stays the sole lifecycle writer, exactly as on
 * the subagent path.
 *
 * Workflow-body module: only the step function and types may be imported
 * here, so the compiled Workflow program stays free of Node builtins.
 */

import { runToolTaskExecutionStep } from "#execution/tasks/parent/tool/executor-step.js";
import type { JsonObject } from "#shared/json.js";

export interface ToolTaskWorkflowInput {
  readonly toolInput: JsonObject;
}

/** Serializable invocation context; never model-visible. */
export interface ToolTaskWorkflowContext {
  readonly taskId: string;
  readonly taskInboxToken: string;
  readonly toolWorkflowId: string;
}

export async function executeToolTaskWorkflow(
  input: ToolTaskWorkflowInput,
  context: ToolTaskWorkflowContext,
): Promise<{ readonly taskId: string }> {
  "use workflow";

  await runToolTaskExecutionStep(input, context);
  return { taskId: context.taskId };
}
