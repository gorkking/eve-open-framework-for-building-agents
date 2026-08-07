import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { readLatestTaskSnapshot } from "#execution/tasks/run-control.js";
import {
  toProxyInputRequestEntries,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";
import { isInputRequest } from "#runtime/input/types.js";

/** Validates and durably records one task-owned child HITL route batch. */
export async function recordTaskInputRequestStep(input: {
  readonly hookPayload: SubagentInputRequestHookPayload;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
  readonly taskId: string;
}): Promise<{ readonly accepted: boolean; readonly sessionState: DurableSessionState }> {
  "use step";

  const durableSession = await readDurableSession(input.sessionState);
  const entry = findSessionTaskEntry(durableSession.state, input.taskId);
  if (entry === undefined || entry.childSessionId !== input.hookPayload.childSessionId) {
    return { accepted: false, sessionState: input.sessionState };
  }
  const view = await readLatestTaskSnapshot({ taskRunId: entry.taskRunId });
  const eventRequestIds = input.hookPayload.event.requests.map((request) => request.requestId);
  const viewRequestIds =
    view?.inputRequests?.map((request) =>
      request !== null && typeof request === "object" && !Array.isArray(request)
        ? Reflect.get(request, "requestId")
        : undefined,
    ) ?? [];
  if (
    view?.status !== "input_required" ||
    !input.hookPayload.event.requests.every(isInputRequest) ||
    view.metadata.mode !== "local" ||
    view.metadata.childSessionId !== input.hookPayload.childSessionId ||
    new Set(eventRequestIds).size !== eventRequestIds.length ||
    eventRequestIds.length !== viewRequestIds.length ||
    eventRequestIds.some((requestId, index) => requestId !== viewRequestIds[index])
  ) {
    return { accepted: false, sessionState: input.sessionState };
  }

  const state = upsertProxyInputRequestState({
    entries: toProxyInputRequestEntries(input.hookPayload, input.taskId),
    forChildContinuationToken: input.hookPayload.childContinuationToken,
    state: durableSession.state,
  });
  return {
    accepted: true,
    sessionState: {
      ...input.sessionState,
      hasProxyInputRequests: true,
      snapshot: {
        session: { ...durableSession, state },
        version: input.sessionState.version,
      },
    },
  };
}
