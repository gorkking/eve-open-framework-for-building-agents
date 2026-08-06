import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import type { AwaitedTaskRef } from "#execution/tasks/await-workflow.js";
import { readLatestTaskSnapshot } from "#execution/tasks/run-control.js";
import { getHookByToken } from "#internal/workflow/runtime.js";
import { createLogger } from "#internal/logging.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";
import { walkCauseChain } from "#shared/errors.js";
import { taskViewsToJson } from "#tasks/json.js";
import type { TaskView } from "#tasks/types.js";
import { resumeHook } from "#internal/workflow/runtime.js";

const log = createLogger("execution.tasks.await");

/**
 * Reads the latest snapshot of every awaited task, or reports that the
 * waiting turn's inbox is gone so the aggregation run can stop polling.
 *
 * A run that has not published its first snapshot yet reads as
 * `working` — the caller holds the creation receipt, which says the
 * same thing.
 */
export async function readAwaitedTaskViewsStep(input: {
  readonly replyToken: string;
  readonly tasks: readonly AwaitedTaskRef[];
}): Promise<
  { readonly kind: "listener-gone" } | { readonly kind: "views"; readonly views: TaskView[] }
> {
  "use step";

  try {
    await getHookByToken(input.replyToken);
  } catch (error) {
    if (isGoneListener(error)) {
      return { kind: "listener-gone" };
    }
    throw error;
  }

  const views = await Promise.all(
    input.tasks.map(
      async (task) =>
        (await readLatestTaskSnapshot({ taskRunId: task.taskRunId })) ?? createPendingView(task),
    ),
  );
  return { kind: "views", views };
}

/** Resolves the pending `task_await` key with its aggregated views. */
export async function postTaskAwaitResultStep(input: {
  readonly callId: string;
  readonly replyToken: string;
  readonly toolName: string;
  readonly views: readonly TaskView[];
}): Promise<void> {
  "use step";

  const result: RuntimeActionResult = {
    callId: input.callId,
    kind: "tool-result",
    output: taskViewsToJson(input.views),
    toolName: input.toolName,
  };
  try {
    await resumeHook(input.replyToken, { kind: "runtime-action-result", results: [result] });
  } catch (error) {
    if (isGoneListener(error)) {
      log.warn("task_await listener disappeared before its result posted", {
        callId: input.callId,
        toolName: input.toolName,
      });
      return;
    }
    throw error;
  }
}

function createPendingView(task: AwaitedTaskRef): TaskView {
  return {
    metadata: task.metadata,
    status: "working",
    taskId: task.taskId,
  };
}

function isGoneListener(error: unknown): boolean {
  for (const candidate of walkCauseChain(error)) {
    if (
      HookNotFoundError.is(candidate) ||
      WorkflowRunNotFoundError.is(candidate) ||
      RunExpiredError.is(candidate) ||
      EntityConflictError.is(candidate)
    ) {
      return true;
    }
  }
  return false;
}
