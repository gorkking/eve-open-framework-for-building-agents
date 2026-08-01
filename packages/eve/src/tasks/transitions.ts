import type { TaskCommand, TaskView } from "#tasks/types.js";
import { isTerminalTaskStatus } from "#tasks/types.js";

/**
 * Outcome of applying one command to a task snapshot.
 *
 * - `accepted`: the state changed; the new view must be appended.
 * - `noop`: the command is recognized and benign (idempotent cancel,
 *   redundant resume); nothing changed and nothing is appended.
 * - `rejected`: the command is invalid for the current status; the
 *   reason is diagnostic only.
 */
export type TaskTransitionResult =
  | { readonly outcome: "accepted"; readonly view: TaskView }
  | { readonly outcome: "noop"; readonly view: TaskView }
  | { readonly outcome: "rejected"; readonly view: TaskView; readonly reason: string };

/**
 * Pure transition function for the task lifecycle:
 *
 * ```text
 * working <-> input_required
 *    |             |
 *    +-----> completed
 *    +-----> failed
 *    +-----> cancelled
 * ```
 *
 * Terminal states are final: a late child result can never revive a
 * cancelled task, and repeated cancellation is idempotent. The durable
 * task run is the only caller that persists accepted views, which is
 * what serializes competing completion, cancellation, and input
 * transitions.
 */
export function applyTaskTransition(view: TaskView, command: TaskCommand): TaskTransitionResult {
  if (isTerminalTaskStatus(view.status)) {
    if (command.kind === "cancel" && view.status === "cancelled") {
      return { outcome: "noop", view };
    }

    return {
      outcome: "rejected",
      reason: `Task "${view.taskId}" is already ${view.status}; "${command.kind}" cannot change a terminal task.`,
      view,
    };
  }

  switch (command.kind) {
    case "complete":
      return {
        outcome: "accepted",
        view: {
          metadata: view.metadata,
          lastOutput: { data: command.data, type: "result" },
          status: "completed",
          statusMessage: view.statusMessage,
          taskId: view.taskId,
        },
      };
    case "fail":
      return {
        outcome: "accepted",
        view: {
          metadata: view.metadata,
          lastOutput: { data: command.data, type: "error" },
          status: "failed",
          statusMessage: view.statusMessage,
          taskId: view.taskId,
        },
      };
    case "cancel":
      return {
        outcome: "accepted",
        view: {
          metadata: view.metadata,
          status: "cancelled",
          statusMessage: view.statusMessage,
          taskId: view.taskId,
        },
      };
    case "require-input":
      return {
        outcome: "accepted",
        view: {
          inputRequests: command.inputRequests,
          metadata: view.metadata,
          status: "input_required",
          statusMessage: view.statusMessage,
          taskId: view.taskId,
        },
      };
    case "resume-working": {
      if (view.status === "working") {
        return { outcome: "noop", view };
      }

      return {
        outcome: "accepted",
        view: {
          metadata: view.metadata,
          status: "working",
          statusMessage: view.statusMessage,
          taskId: view.taskId,
        },
      };
    }
    case "describe": {
      if (view.metadata.childSessionId === command.childSessionId) {
        return { outcome: "noop", view };
      }

      return {
        outcome: "accepted",
        view: {
          ...view,
          metadata: { ...view.metadata, childSessionId: command.childSessionId },
        },
      };
    }
  }
}
