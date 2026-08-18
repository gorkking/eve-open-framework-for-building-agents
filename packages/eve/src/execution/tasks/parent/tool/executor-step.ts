import { sendTaskInboundPayload } from "#execution/tasks/parent/run-parent.js";
import type {
  ToolTaskWorkflowContext,
  ToolTaskWorkflowInput,
} from "#execution/tasks/parent/tool/executor.js";
import { start } from "#internal/workflow/runtime.js";
import type { JsonObject, JsonValue } from "#shared/json.js";
import type { TaskInboundChildResult } from "#tasks/types.js";

/**
 * Starts the tool's Workflow, awaits its result, and settles the task.
 * Known residual (shared with the subagent path): `start()` inside a
 * retryable step is a non-deduplicated side effect — a retry after a
 * successful start can run the tool's Workflow twice; the task run's
 * single-writer hook claim contains the damage to one recorded outcome.
 */
export async function runToolTaskExecutionStep(
  input: ToolTaskWorkflowInput,
  context: ToolTaskWorkflowContext,
): Promise<void> {
  "use step";

  let result: TaskInboundChildResult["results"][number];
  try {
    const run = await start<[JsonObject], JsonValue>({ workflowId: context.toolWorkflowId }, [
      input.toolInput,
    ]);
    const output = await run.returnValue;
    result = {
      outcome: { kind: "terminal", result: { kind: "succeeded", output } },
      output,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    result = {
      isError: true,
      outcome: { kind: "terminal", result: { error: message, kind: "failed" } },
      output: message,
    };
  }

  await sendTaskInboundPayload({
    payload: { kind: "runtime-action-result", results: [result] },
    taskInboxToken: context.taskInboxToken,
  });
}
