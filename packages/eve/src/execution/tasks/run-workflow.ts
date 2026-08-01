import { createHook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import { appendTaskSnapshotStep } from "#execution/tasks/run-steps.js";
import { applyTaskTransition } from "#tasks/transitions.js";
import { isTerminalTaskStatus, type TaskCommandHookPayload, type TaskView } from "#tasks/types.js";

/** Input for one durable task run. */
export interface TaskRunWorkflowInput {
  /** Private command-hook token; a routing credential, never model-visible. */
  readonly commandToken: string;
  /** The creation snapshot, normally `working`. */
  readonly initialView: TaskView;
}

/**
 * The durable task run: single writer for one task's lifecycle.
 *
 * Consumes commands over its private hook, applies the pure transition
 * function, and appends a full `TaskView` snapshot per accepted command
 * to its `eve.task` run stream. Competing completion, cancellation, and
 * input transitions serialize here; rejected commands (for example a
 * late child result after `cancelled`) change nothing.
 *
 * The run ends when the task reaches a terminal status. Its snapshot
 * stream stays readable, so terminal tasks remain peekable; the
 * disposed hook makes any later command fail loudly instead of queueing
 * against a finished task.
 */
export async function taskRunWorkflow(input: TaskRunWorkflowInput): Promise<void> {
  "use workflow";

  const commands = createHook<TaskCommandHookPayload>({ token: input.commandToken });
  // The iterator shares the hook's durable cursor; create it before
  // claiming so conflict replay is consumed by getConflict(), not a
  // later iterator read.
  const iterator = commands[Symbol.asyncIterator]();
  let ownsHook = false;

  try {
    try {
      await claimHookOwnership(commands);
      ownsHook = true;
    } catch (error) {
      // A duplicate start for the same task (crash between the start
      // side effect and its step commit) loses the claim and exits;
      // the surviving run owns the lifecycle.
      if (isHookConflictError(error)) return;
      throw error;
    }

    let view = input.initialView;
    await appendTaskSnapshotStep({ view });

    while (!isTerminalTaskStatus(view.status)) {
      const next = await iterator.next();
      if (next.done === true) return;
      const result = applyTaskTransition(view, next.value.command);
      if (result.outcome !== "accepted") continue;
      view = result.view;
      await appendTaskSnapshotStep({ view });
    }
  } finally {
    // Dispose-only teardown: `iterator.return()` would await a pending
    // durable read that never settles, leaving this run `running`
    // forever and its hook unswept.
    if (ownsHook) await disposeHook(commands);
  }
}
