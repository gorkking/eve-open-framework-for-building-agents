import { sleep } from "#compiled/@workflow/core/index.js";

import { postTaskAwaitResultStep, readAwaitedTaskViewsStep } from "#execution/tasks/await-steps.js";
import { isReadyTaskStatus } from "#tasks/types.js";
import type { TaskMetadata } from "#tasks/types.js";

const DEFAULT_POLL_INTERVAL_MS = 10_000;

/** One awaited task: the model-visible id plus its run's read coordinates. */
export interface AwaitedTaskRef {
  readonly metadata: TaskMetadata;
  readonly taskId: string;
  readonly taskRunId: string;
}

/** Input for one `task_await` aggregation run. */
export interface TaskAwaitWorkflowInput {
  readonly callId: string;
  readonly pollIntervalMs?: number;
  /** The waiting turn's inbox token; the result resumes the existing wait. */
  readonly replyToken: string;
  readonly tasks: readonly AwaitedTaskRef[];
  readonly toolName: string;
}

/**
 * Aggregates one `task_await` call across its selected task runs.
 *
 * `task_await` returns when *every* selected task is terminal or
 * `input_required`, so someone must observe all of them; the task runs
 * are single-task writers and the parent turn can only wait on its
 * inbox. This small durable run polls the snapshot streams and, once
 * every task is ready, posts the one `tool-result` the pending
 * `task_await` key is waiting for.
 *
 * The run exits without posting when the waiting turn is gone (its
 * inbox was disposed by completion or cancellation) — the model asked,
 * then stopped listening.
 */
export async function taskAwaitWorkflow(input: TaskAwaitWorkflowInput): Promise<void> {
  "use workflow";

  while (true) {
    const observation = await readAwaitedTaskViewsStep({
      replyToken: input.replyToken,
      tasks: input.tasks,
    });
    if (observation.kind === "listener-gone") return;

    if (observation.views.every((view) => isReadyTaskStatus(view.status))) {
      await postTaskAwaitResultStep({
        callId: input.callId,
        replyToken: input.replyToken,
        toolName: input.toolName,
        views: observation.views,
      });
      return;
    }

    await sleep(input.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  }
}
