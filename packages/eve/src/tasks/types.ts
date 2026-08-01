import type { JsonValue } from "#shared/json.js";

/**
 * Task lifecycle contract for `experimental.tasks`.
 *
 * A task is one durable unit of delegated work owned by a parent session.
 * The durable task run is the single writer for lifecycle transitions
 * (see `#execution/tasks/run-workflow.js`); every other path submits
 * commands and reads snapshots. This module is dependency-free on
 * purpose: it is bundled into workflow bodies, which reject Node.js
 * builtins and heavyweight validators.
 */

/**
 * Task lifecycle status.
 *
 * `completed`, `failed`, and `cancelled` are terminal and final.
 * `input_required` is not terminal but is ready for parent action, so
 * `task_await` returns for it — a parent must never deadlock while its
 * child waits for input.
 */
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

/** Immutable identity of the delegated work behind a task. */
export interface TaskMetadata {
  readonly kind: "subagent";
  readonly mode: "local" | "remote";
  /** Authored subagent name the parent dispatched. */
  readonly name: string;
  /** Child session acknowledged at dispatch. */
  readonly childSessionId: string;
  /** Remote children only: the child agent's base URL. */
  readonly url?: string;
}

/**
 * Terminal task output. Failure is the state (`failed`); the `error`
 * output is its consequence — a `failed` task always carries one.
 * This intentionally diverges from MCP, which reserves `failed` for
 * protocol-level errors.
 */
export type TaskOutput =
  | { readonly type: "result"; readonly data: JsonValue }
  | { readonly type: "error"; readonly data: JsonValue };

/**
 * One outstanding request forwarded from a blocked child. Carried
 * opaquely: the task layer routes the batch, the input contract owns
 * its shape.
 */
export type TaskInputRequest = JsonValue;

/**
 * Full durable task snapshot. The task run appends one per accepted
 * command; readers always observe a complete view, never a delta.
 * Never contains routing credentials, continuation tokens, or
 * authorization capabilities.
 */
export interface TaskView {
  readonly taskId: string;
  readonly status: TaskStatus;
  /** Latest child-reported progress message (unused until the progress flow lands). */
  readonly statusMessage?: string;
  readonly metadata: TaskMetadata;
  /** Terminal output; present exactly when `status` is terminal. */
  readonly lastOutput?: TaskOutput;
  /** Outstanding requests; present exactly when `status` is `input_required`. */
  readonly inputRequests?: readonly TaskInputRequest[];
}

/** Commands accepted by the durable task run's transition function. */
export type TaskCommand =
  | { readonly kind: "complete"; readonly data: JsonValue }
  | { readonly kind: "fail"; readonly data: JsonValue }
  | { readonly kind: "cancel" }
  | { readonly kind: "require-input"; readonly inputRequests: readonly TaskInputRequest[] }
  | { readonly kind: "resume-working" };

/** Hook payload envelope commanding a durable task run. */
export interface TaskCommandHookPayload {
  readonly kind: "task-command";
  readonly command: TaskCommand;
}

/** Namespaced run stream carrying `TaskView` snapshots. */
export const TASK_SNAPSHOT_STREAM_NAMESPACE = "eve.task";

/** True when the status can never change again. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** True when `task_await` should stop waiting on this status. */
export function isReadyTaskStatus(status: TaskStatus): boolean {
  return status === "input_required" || isTerminalTaskStatus(status);
}
