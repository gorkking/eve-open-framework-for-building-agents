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
 * `input_required` is not terminal but is ready for parent action — a
 * parent must never deadlock while its child waits for input.
 */
export type TaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";

/**
 * Immutable identity of the delegated work behind a task.
 *
 * `childSessionId` is optional because the task run is created before
 * the child acknowledges its session — the durable record must exist
 * before the dispatch side effect so a fast child always has a live
 * command hook to answer. The `describe` command attaches the id at
 * acknowledgement.
 */
export interface TaskMetadata {
  readonly kind: "subagent";
  readonly mode: "local" | "remote";
  /** Authored subagent name the parent dispatched. */
  readonly name: string;
  /** Child session acknowledged at dispatch. */
  readonly childSessionId?: string;
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
  | { readonly kind: "resume-working" }
  | { readonly kind: "describe"; readonly childSessionId: string };

/** Hook payload envelope commanding a durable task run. */
export interface TaskCommandHookPayload {
  readonly kind: "task-command";
  readonly command: TaskCommand;
}

/**
 * Structural shapes of the child wire payloads a task run consumes.
 *
 * These mirror the existing parent-notification contracts (the local
 * `notifyDelegatedParentStep`, the subagent adapter's HITL forwarding,
 * and the remote callback route) without importing their zod-backed
 * modules: this file is bundled into workflow bodies. The wire itself
 * is unchanged — delegated dispatch only points it at the task run's
 * hook instead of the parent turn's inbox.
 */
export interface TaskInboundChildResult {
  readonly kind: "runtime-action-result";
  readonly results: readonly {
    readonly isError?: boolean;
    readonly outcome?: {
      readonly kind: "parked" | "terminal";
      readonly result:
        | { readonly kind: "succeeded"; readonly output: JsonValue }
        | { readonly error: JsonValue; readonly kind: "failed" }
        | { readonly kind: "cancelled" };
      /** Provider usage this turn added; accounting is deferred to a later stage. */
      readonly usageDelta?: unknown;
    };
    readonly output: JsonValue;
  }[];
}

export interface TaskInboundInputRequest {
  readonly kind: "subagent-input-request";
  readonly event: { readonly requests: readonly TaskInputRequest[] };
}

export interface TaskInboundAuthorizationEvent {
  readonly kind: "subagent-authorization-event";
  readonly event: { readonly type: "authorization.required" | "authorization.completed" };
}

/** Everything a task run's command hook may receive. */
export type TaskRunInboundPayload =
  | TaskCommandHookPayload
  | TaskInboundChildResult
  | TaskInboundInputRequest
  | TaskInboundAuthorizationEvent;

/** Namespaced run stream carrying `TaskView` snapshots. */
export const TASK_SNAPSHOT_STREAM_NAMESPACE = "eve.task";

/** True when the status can never change again. */
export function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** True when the status is actionable by the parent: terminal or awaiting input. */
export function isReadyTaskStatus(status: TaskStatus): boolean {
  return status === "input_required" || isTerminalTaskStatus(status);
}
