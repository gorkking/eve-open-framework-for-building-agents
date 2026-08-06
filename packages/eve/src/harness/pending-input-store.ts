import type { ModelMessage } from "ai";
import type { InputRequest } from "#runtime/input/types.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";

const KEY = "eve.runtime.pendingInputBatch";
export interface PendingInputBatchEvent {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}
export interface PendingInputBatch {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseMessages: readonly ModelMessage[];
}
interface RequestRecord {
  readonly position: number;
  readonly request: InputRequest;
  readonly suffixGroupId: string;
}
interface SuffixGroup {
  readonly event?: PendingInputBatchEvent;
  readonly position: number;
  readonly responseMessages: readonly ModelMessage[];
}
interface Store {
  readonly nextSuffixGroupSequence: number;
  readonly requestsById: Readonly<Record<string, RequestRecord>>;
  readonly suffixGroupsById: Readonly<Record<string, SuffixGroup>>;
}

export function requestIds(state: SessionStateMap | undefined): ReadonlySet<string> {
  const store = read(state);
  return new Set(store ? Object.keys(store.requestsById) : []);
}
export function oldest(state: SessionStateMap | undefined): PendingInputBatch | undefined {
  const store = read(state);
  if (!store) return;
  const entry = Object.entries(store.suffixGroupsById).sort(
    ([, a], [, b]) => a.position - b.position,
  )[0];
  if (!entry) return;
  const [id, group] = entry;
  const requests = Object.values(store.requestsById)
    .filter((r) => r.suffixGroupId === id)
    .sort((a, b) => a.position - b.position)
    .map((r) => r.request);
  return { event: group.event, requests, responseMessages: group.responseMessages };
}
export function append(input: {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  const current = read(input.session.state) ?? {
    nextSuffixGroupSequence: 0,
    requestsById: {},
    suffixGroupsById: {},
  };
  for (const request of input.requests)
    if (current.requestsById[request.requestId])
      throw new Error(`Pending input request "${request.requestId}" already exists.`);
  const id = `group_${current.nextSuffixGroupSequence}`;
  const requestsById = { ...current.requestsById };
  input.requests.forEach((request, position) => {
    requestsById[request.requestId] = { position, request, suffixGroupId: id };
  });
  const state = {
    ...input.session.state,
    [KEY]: {
      nextSuffixGroupSequence: current.nextSuffixGroupSequence + 1,
      requestsById,
      suffixGroupsById: {
        ...current.suffixGroupsById,
        [id]: {
          event: input.event,
          position: current.nextSuffixGroupSequence,
          responseMessages: [...input.responseMessages],
        },
      },
    } satisfies Store,
  };
  return { ...input.session, state };
}
export function removeOldest(session: HarnessSession): HarnessSession {
  const store = read(session.state);
  const batch = oldest(session.state);
  if (!store || !batch) return session;
  const ids = new Set(batch.requests.map((r) => r.requestId));
  const groupId = Object.values(store.requestsById).find((r) =>
    ids.has(r.request.requestId),
  )?.suffixGroupId;
  if (!groupId) return session;
  const requestsById = Object.fromEntries(
    Object.entries(store.requestsById).filter(([, r]) => r.suffixGroupId !== groupId),
  );
  const suffixGroupsById = { ...store.suffixGroupsById };
  delete suffixGroupsById[groupId];
  const state = { ...session.state };
  if (Object.keys(suffixGroupsById).length)
    state[KEY] = { ...store, requestsById, suffixGroupsById };
  else delete state[KEY];
  return { ...session, state: Object.keys(state).length ? state : undefined };
}
function read(state: SessionStateMap | undefined): Store | undefined {
  const value = state?.[KEY] as Partial<Store> | undefined;
  return value &&
    typeof value.nextSuffixGroupSequence === "number" &&
    value.requestsById &&
    value.suffixGroupsById
    ? (value as Store)
    : undefined;
}
