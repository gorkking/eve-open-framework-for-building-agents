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
interface Group extends PendingInputBatch {
  readonly id: string;
}
interface State {
  readonly groups: readonly Group[];
  readonly nextGroupSequence: number;
}

export function requestIds(state: SessionStateMap | undefined): ReadonlySet<string> {
  return new Set(read(state)?.groups.flatMap((group) => group.requests.map((r) => r.requestId)));
}
export function oldest(state: SessionStateMap | undefined): PendingInputBatch | undefined {
  return read(state)?.groups[0];
}
export function append(input: {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  const current = read(input.session.state) ?? { groups: [], nextGroupSequence: 0 };
  const ids = requestIds(input.session.state);
  for (const request of input.requests)
    if (ids.has(request.requestId))
      throw new Error(`Pending input request "${request.requestId}" already exists.`);
  const group: Group = {
    event: input.event,
    id: `group_${current.nextGroupSequence}`,
    requests: [...input.requests],
    responseMessages: [...input.responseMessages],
  };
  return {
    ...input.session,
    state: {
      ...input.session.state,
      [KEY]: {
        groups: [...current.groups, group],
        nextGroupSequence: current.nextGroupSequence + 1,
      } satisfies State,
    },
  };
}
export function removeOldest(session: HarnessSession): HarnessSession {
  const current = read(session.state);
  if (!current?.groups.length) return session;
  const groups = current.groups.slice(1);
  const state = { ...session.state };
  if (groups.length) state[KEY] = { ...current, groups };
  else delete state[KEY];
  return { ...session, state: Object.keys(state).length ? state : undefined };
}
function read(state: SessionStateMap | undefined): State | undefined {
  const value = state?.[KEY] as Partial<State> | undefined;
  return value && Array.isArray(value.groups) && typeof value.nextGroupSequence === "number"
    ? (value as State)
    : undefined;
}
