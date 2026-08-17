import type { ContextContainer } from "#context/container.js";
import { ContinuationTokenKey, SessionCallbackKey, SessionIdKey } from "#context/keys.js";
import { fireTaskEventCallbackStep } from "#execution/session-callback-step.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

type TaskCallbackEvent = Extract<
  UnstampedMessageStreamEvent,
  {
    readonly type:
      | "approval.candidate"
      | "approval.settled"
      | "authorization.completed"
      | "authorization.required"
      | "input.requested";
  }
>;

/** Forwards one task-owned remote event; local children have no callback context. */
export async function forwardTaskCallbackEvent(input: {
  readonly ctx: ContextContainer;
  readonly event: UnstampedMessageStreamEvent;
}): Promise<void> {
  const callback = input.ctx.get(SessionCallbackKey);
  if (callback?.taskId === undefined || !isTaskCallbackEvent(input.event)) return;

  await fireTaskEventCallbackStep({
    callback,
    childContinuationToken: input.ctx.require(ContinuationTokenKey),
    childSessionId: input.ctx.require(SessionIdKey),
    event: input.event,
  });
}

function isTaskCallbackEvent(event: UnstampedMessageStreamEvent): event is TaskCallbackEvent {
  return (
    event.type === "approval.candidate" ||
    event.type === "approval.settled" ||
    event.type === "authorization.completed" ||
    event.type === "authorization.required" ||
    event.type === "input.requested"
  );
}
