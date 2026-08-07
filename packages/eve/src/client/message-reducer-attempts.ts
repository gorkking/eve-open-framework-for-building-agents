import type { EveAgentReducerEvent } from "#client/reducer.js";
import type { EveMessageData } from "#client/message-reducer-types.js";

export function projectPartIdentity(input: {
  readonly attemptId?: string;
  readonly stepId?: string;
}): { readonly attemptId?: string; readonly stepId?: string } {
  const identity: { attemptId?: string; stepId?: string } = {};
  if (input.attemptId !== undefined) identity.attemptId = input.attemptId;
  if (input.stepId !== undefined) identity.stepId = input.stepId;
  return identity;
}

export function projectResultIdentity(input: {
  readonly attemptId?: string;
  readonly stepId?: string;
}): { readonly resultAttemptId?: string; readonly resultStepId?: string } {
  const identity: { resultAttemptId?: string; resultStepId?: string } = {};
  if (input.attemptId !== undefined) identity.resultAttemptId = input.attemptId;
  if (input.stepId !== undefined) identity.resultStepId = input.stepId;
  return identity;
}

export function isSupersededAttemptEvent(
  data: EveMessageData,
  event: EveAgentReducerEvent,
): boolean {
  if (event.type === "attempt.started" || !("data" in event)) return false;
  const identity = event.data as { readonly attemptId?: unknown; readonly stepId?: unknown };
  if (typeof identity.attemptId !== "string" || typeof identity.stepId !== "string") return false;

  for (const message of data.messages) {
    if (message.role !== "assistant") continue;
    const step = message.parts.find(
      (part) => part.type === "step-start" && part.stepId === identity.stepId,
    );
    if (step?.type === "step-start" && step.activeAttemptId !== undefined) {
      return step.activeAttemptId !== identity.attemptId;
    }
  }
  return false;
}
