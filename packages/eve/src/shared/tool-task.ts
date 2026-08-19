import type { JsonObject } from "#shared/json.js";

const TASK_DELEGATED_KIND = "eve:task-delegated";

/** Private address an executor uses to report lifecycle changes to its owning task. */
export interface TaskBinding {
  readonly taskId: string;
  readonly token: string;
  readonly url?: string;
}

/** Opaque, task-private address used to control an external executor. */
export interface TaskExecutorBinding {
  readonly kind: string;
  readonly data: JsonObject;
}

/** Model-facing acknowledgement returned when an executor accepts delegated work. */
export type TaskReceipt<TData extends JsonObject = JsonObject> = TData & {
  readonly status: "working";
  readonly taskId: string;
};

/**
 * Sentinel returned by a background tool after an external executor accepts
 * responsibility for the task. Returning it ends `execute`; it does not
 * complete the durable task.
 */
export interface TaskDelegated<TData extends JsonObject = JsonObject> {
  readonly kind: typeof TASK_DELEGATED_KIND;
  readonly executor: TaskExecutorBinding;
  readonly receipt: TaskReceipt<TData>;
}

/** Task capability passed only to tools declared with `execution: "background"`. */
export interface TaskExec {
  readonly binding: TaskBinding;

  delegated<TData extends JsonObject>(input: {
    readonly executor: TaskExecutorBinding;
    readonly receipt: TData;
  }): TaskDelegated<TData>;
}

export function createTaskDelegated<TData extends JsonObject>(input: {
  readonly binding: TaskBinding;
  readonly executor: TaskExecutorBinding;
  readonly receipt: TData;
}): TaskDelegated<TData> {
  return {
    executor: input.executor,
    kind: TASK_DELEGATED_KIND,
    receipt: { ...input.receipt, status: "working", taskId: input.binding.taskId },
  };
}

export function isTaskDelegated(value: unknown): value is TaskDelegated {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === TASK_DELEGATED_KIND
  );
}
