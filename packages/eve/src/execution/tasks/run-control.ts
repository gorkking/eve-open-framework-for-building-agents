import {
  EntityConflictError,
  HookNotFoundError,
  RunExpiredError,
  WorkflowRunNotFoundError,
} from "#compiled/@workflow/errors/index.js";

import type { TaskRunWorkflowInput } from "#execution/tasks/run-workflow.js";
import {
  startWorkflowPreferLatest,
  taskRunWorkflowReference,
} from "#execution/workflow-runtime.js";
import { getRun, resumeHook } from "#internal/workflow/runtime.js";
import { walkCauseChain } from "#shared/errors.js";
import {
  TASK_SNAPSHOT_STREAM_NAMESPACE,
  isReadyTaskStatus,
  type TaskCommand,
  type TaskCommandHookPayload,
  type TaskView,
} from "#tasks/types.js";

const TASK_SNAPSHOT_READ_TIMEOUT_MS = 10_000;

/**
 * Node-side controls for durable task runs. Every export must be called
 * from inside a `"use step"` body; none of these are steps themselves so
 * dispatch and tool steps can compose them inside one durable boundary.
 */

/** Starts the durable run owning one task's lifecycle. */
export async function startTaskRun(
  input: TaskRunWorkflowInput,
): Promise<{ readonly runId: string }> {
  const run = await startWorkflowPreferLatest(taskRunWorkflowReference, [input]);
  return { runId: run.runId };
}

/**
 * Submits one command to a task run.
 *
 * `unreachable` means the run already finished and disposed its hook —
 * the task is terminal, and the caller should read the final snapshot
 * instead of treating the send as a failure.
 */
export async function sendTaskCommand(input: {
  readonly command: TaskCommand;
  readonly commandToken: string;
}): Promise<"delivered" | "unreachable"> {
  const payload: TaskCommandHookPayload = { command: input.command, kind: "task-command" };
  try {
    await resumeHook(input.commandToken, payload);
    return "delivered";
  } catch (error) {
    if (isFinishedTaskRunTarget(error)) {
      return "unreachable";
    }
    throw error;
  }
}

/**
 * Reads the latest snapshot a task run has published, or `undefined`
 * when the run has not committed its first snapshot yet (the caller
 * already holds the creation receipt, which is `working`).
 *
 * Snapshots are trusted without re-validation: the task run is the
 * single writer and every write passed the transition function.
 */
export async function readLatestTaskSnapshot(input: {
  readonly taskRunId: string;
}): Promise<TaskView | undefined> {
  const stream = getRun<unknown>(input.taskRunId).getReadable<TaskView>({
    namespace: TASK_SNAPSHOT_STREAM_NAMESPACE,
    startIndex: -1,
  });
  const tailIndex = await stream.getTailIndex();
  const reader = stream.getReader();
  try {
    if (tailIndex < 0) {
      return undefined;
    }
    const result = await readWithTimeout(reader, "latest task snapshot");
    return result;
  } finally {
    await reader.cancel("eve task snapshot read complete").catch(() => {});
    reader.releaseLock();
  }
}

/**
 * Waits until a task run publishes a ready snapshot — terminal or
 * `input_required` — starting from the latest published state. Returns
 * immediately when the task is already ready.
 *
 * Unlike {@link readLatestTaskSnapshot} this read has no timeout; the
 * caller owns cancellation by racing this promise (for example against
 * turn cancellation) and abandoning it.
 */
export async function waitForReadyTaskSnapshot(input: {
  readonly taskRunId: string;
}): Promise<TaskView> {
  const stream = getRun<unknown>(input.taskRunId).getReadable<TaskView>({
    namespace: TASK_SNAPSHOT_STREAM_NAMESPACE,
    startIndex: -1,
  });
  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done || value === undefined) {
        throw new Error(
          `Task run "${input.taskRunId}" closed its snapshot stream without a ready snapshot.`,
        );
      }
      if (isReadyTaskStatus(value.status)) {
        return value;
      }
    }
  } finally {
    await reader.cancel("eve task snapshot wait complete").catch(() => {});
    reader.releaseLock();
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<TaskView>,
  what: string,
): Promise<TaskView | undefined> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read().then((read) => ({ kind: "read" as const, read })),
      new Promise<{ readonly kind: "timeout" }>((resolve) => {
        timeout = setTimeout(() => resolve({ kind: "timeout" }), TASK_SNAPSHOT_READ_TIMEOUT_MS);
      }),
    ]);
    if (result.kind === "timeout") {
      throw new Error(`Timed out reading ${what} after ${TASK_SNAPSHOT_READ_TIMEOUT_MS}ms.`);
    }
    if (result.read.done) {
      return undefined;
    }
    return result.read.value;
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
}

function isFinishedTaskRunTarget(error: unknown): boolean {
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
