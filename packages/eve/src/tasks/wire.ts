import type { TaskCommand, TaskRunInboundPayload } from "#tasks/types.js";

/**
 * Translates one inbound hook payload into a lifecycle command.
 *
 * The child wire is unchanged by `experimental.tasks`; delegated
 * dispatch hands children the task run's hook token, so the payloads
 * that used to resume the parent turn arrive here instead:
 *
 * - a settled child turn (local notification or remote callback)
 *   carries an explicit outcome — its result status decides
 *   `complete`, `fail`, or `cancel`;
 * - a forwarded HITL batch marks the task `input_required` with the
 *   outstanding requests;
 * - `authorization.required` also blocks the task (the child cannot
 *   proceed without the parent's user), and `authorization.completed`
 *   returns it to `working`. Authorization payloads never enter the
 *   snapshot — only the fact that the child is blocked does.
 *
 * Returns `undefined` for unrecognized payloads, which the run ignores.
 */
export function translateTaskInboundPayload(
  payload: TaskRunInboundPayload,
): TaskCommand | undefined {
  switch (payload.kind) {
    case "task-command":
      return payload.command;
    case "runtime-action-result": {
      const result = payload.results[0];
      if (result === undefined) return undefined;
      if (result.outcome !== undefined) {
        switch (result.outcome.result.kind) {
          case "succeeded":
            return { data: result.output, kind: "complete" };
          case "failed":
            return { data: result.output, kind: "fail" };
          case "cancelled":
            return { kind: "cancel" };
        }
      }
      return result.isError === true
        ? { data: result.output, kind: "fail" }
        : { data: result.output, kind: "complete" };
    }
    case "subagent-input-request":
      return { inputRequests: payload.event.requests, kind: "require-input" };
    case "subagent-authorization-event":
      return payload.event.type === "authorization.required"
        ? { inputRequests: [{ blockedOn: "authorization" }], kind: "require-input" }
        : { kind: "resume-working" };
    default:
      return undefined;
  }
}
