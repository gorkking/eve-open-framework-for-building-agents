import type { SubagentInputRequestHookPayload } from "#channel/types.js";
import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { readLatestTaskSnapshot } from "#execution/tasks/run-control.js";
import {
  toProxyInputRequestEntries,
  upsertProxyInputRequestState,
} from "#harness/proxy-input-requests.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { isInputRequest } from "#runtime/input/types.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";

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
  const handle = (getAgentHandleStore(durableSession.state)?.handles ?? []).find(
    (candidate) =>
      candidate.phase === "addressed" && candidate.identity.id === entry?.metadata.agentId,
  );
  if (
    entry === undefined ||
    handle?.phase !== "addressed" ||
    handle.address.kind === "agent/remote" ||
    handle.address.sessionId !== input.hookPayload.childSessionId
  ) {
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
    view.metadata.agentId !== entry.metadata.agentId ||
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
