import type { ModelMessage } from "ai";
import type { InputRequest } from "#runtime/input/types.js";
import type { HarnessSession, SessionStateMap } from "#harness/types.js";

const KEY = "eve.runtime.pendingInputBatch";
export interface PendingInputBatchEvent {
  readonly sequence: number;
  readonly stepIndex: number;
  readonly turnId: string;
}
export interface AssistantTurnInputBatch {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseMessages: readonly ModelMessage[];
}
interface StoredAssistantTurnInputBatch extends AssistantTurnInputBatch {
  readonly id: string;
}
interface State {
  readonly batches: readonly StoredAssistantTurnInputBatch[];
  readonly nextBatchSequence: number;
}

export function getPendingInputRequestIdsFromState(
  state: SessionStateMap | undefined,
): ReadonlySet<string> {
  return new Set(read(state)?.batches.flatMap((batch) => batch.requests.map((r) => r.requestId)));
}
export function getOldestAssistantTurnInputBatch(
  state: SessionStateMap | undefined,
): AssistantTurnInputBatch | undefined {
  return read(state)?.batches[0];
}
export function appendAssistantTurnInputBatch(input: {
  readonly event?: PendingInputBatchEvent;
  readonly requests: readonly InputRequest[];
  readonly responseMessages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): HarnessSession {
  const current = read(input.session.state) ?? { batches: [], nextBatchSequence: 0 };
  const ids = getPendingInputRequestIdsFromState(input.session.state);
  for (const request of input.requests)
    if (ids.has(request.requestId))
      throw new Error(`Pending input request "${request.requestId}" already exists.`);
  const batch: StoredAssistantTurnInputBatch = {
    event: input.event,
    id: `batch_${current.nextBatchSequence}`,
    requests: [...input.requests],
    responseMessages: [...input.responseMessages],
  };
  return {
    ...input.session,
    state: {
      ...input.session.state,
      [KEY]: {
        batches: [...current.batches, batch],
        nextBatchSequence: current.nextBatchSequence + 1,
      } satisfies State,
    },
  };
}
export function removeOldestAssistantTurnInputBatch(session: HarnessSession): HarnessSession {
  const current = read(session.state);
  if (!current?.batches.length) return session;
  const batches = current.batches.slice(1);
  const state = { ...session.state };
  if (batches.length) state[KEY] = { ...current, batches };
  else delete state[KEY];
  return { ...session, state: Object.keys(state).length ? state : undefined };
}
function read(state: SessionStateMap | undefined): State | undefined {
  const value = state?.[KEY] as Partial<State> | undefined;
  return value && Array.isArray(value.batches) && typeof value.nextBatchSequence === "number"
    ? (value as State)
    : undefined;
}
