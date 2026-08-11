import { contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { type JsonValue, parseJsonValue } from "#shared/json.js";

interface InstrumentationStateRecord {
  abandoned?: true;
  attemptId?: string;
  value?: JsonValue;
}

type InstrumentationStateMap = Readonly<Record<string, InstrumentationStateRecord>>;

const InstrumentationStateKey = new ContextKey<InstrumentationStateMap>(
  "eve.harness.instrumentationState",
  {
    codec: {
      deserialize: deserializeState,
      serialize: (state) => state,
    },
  },
);

/** Keeps provider state from an interrupted step's discarded context changes. */
export function preserveSerializedInstrumentationState(
  original: Record<string, unknown>,
  interrupted: Record<string, unknown>,
): Record<string, unknown> {
  const state = interrupted[InstrumentationStateKey.name];
  return state === undefined ? original : { ...original, [InstrumentationStateKey.name]: state };
}

export interface InstrumentationStateSlot {
  get(): JsonValue | undefined;
  set(value: JsonValue | undefined): void;
}

export interface InstrumentationStateLease extends InstrumentationStateSlot {
  revoke(): void;
}

/** One provider's durable state for one operation. */
export function instrumentationStateSlot(
  provider: string,
  idempotencyKey: string,
  attemptId?: string,
): InstrumentationStateLease {
  const key = stateKey(provider, idempotencyKey);
  let active = true;
  return {
    get: () => {
      if (!active) return undefined;
      const value = contextStorage.getStore()?.get(InstrumentationStateKey)?.[key]?.value;
      return value === undefined ? undefined : cloneAndFreezeJson(value);
    },
    revoke: () => {
      active = false;
    },
    set: (value) => {
      if (!active || contextStorage.getStore() === undefined) return;
      if (value === undefined) {
        writeState((state) => writeSlot(state, key, undefined));
        return;
      }
      const record: InstrumentationStateRecord = {
        value: cloneAndFreezeJson(parseJsonValue(value)),
      };
      const current = contextStorage.getStore()?.get(InstrumentationStateKey)?.[key];
      if (current?.abandoned === true) record.abandoned = true;
      if (attemptId !== undefined) record.attemptId = attemptId;
      writeState((state) => writeSlot(state, key, record));
    },
  };
}

export function abandonInstrumentationState(
  provider: string,
  idempotencyKey: string,
  attemptId?: string,
): void {
  if (contextStorage.getStore() === undefined) return;
  const key = stateKey(provider, idempotencyKey);
  writeState((state) => {
    const current = state[key];
    const record: InstrumentationStateRecord = { abandoned: true };
    const owner = attemptId ?? current?.attemptId;
    if (owner !== undefined) record.attemptId = owner;
    if (current?.value !== undefined) record.value = current.value;
    return writeSlot(state, key, record);
  });
}

export function isInstrumentationStateAbandoned(provider: string, idempotencyKey: string): boolean {
  return (
    contextStorage.getStore()?.get(InstrumentationStateKey)?.[stateKey(provider, idempotencyKey)]
      ?.abandoned === true
  );
}

/** Releases one operation across namespaces, including providers no longer registered. */
export function releaseAllInstrumentationState(idempotencyKey: string): void {
  const suffix = `\0${idempotencyKey}`;
  releaseMatchingInstrumentationState((key) => key.endsWith(suffix));
}

/** Releases attempt-owned children across namespaces when their terminals are omitted. */
export function releaseAllInstrumentationAttemptState(attemptId: string): void {
  releaseMatchingInstrumentationState((_key, record) => record.attemptId === attemptId);
}

function releaseMatchingInstrumentationState(
  matches: (key: string, record: InstrumentationStateRecord) => boolean,
): void {
  const current = contextStorage.getStore()?.get(InstrumentationStateKey);
  if (
    current === undefined ||
    !Object.entries(current).some(([key, record]) => matches(key, record))
  ) {
    return;
  }
  writeState((state) => {
    const next = { ...state };
    for (const [key, record] of Object.entries(state)) {
      if (matches(key, record)) delete next[key];
    }
    return next;
  });
}

function writeState(update: (state: InstrumentationStateMap) => InstrumentationStateMap): void {
  loadContext().set(InstrumentationStateKey, (state) => update(state ?? {}));
}

function writeSlot(
  state: InstrumentationStateMap,
  key: string,
  value: InstrumentationStateRecord | undefined,
): InstrumentationStateMap {
  const next = { ...state };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}

function stateKey(provider: string, idempotencyKey: string): string {
  return `${provider}\0${idempotencyKey}`;
}

function deserializeState(data: unknown): InstrumentationStateMap {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  const state: Record<string, InstrumentationStateRecord> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) continue;
    const record = value as Record<string, unknown>;
    const parsed: InstrumentationStateRecord = {};
    if (record["abandoned"] === true) parsed.abandoned = true;
    if (typeof record["attemptId"] === "string") parsed.attemptId = record["attemptId"];
    if (record["value"] !== undefined) {
      parsed.value = cloneAndFreezeJson(record["value"] as JsonValue);
    }
    if (parsed.abandoned === true || parsed.value !== undefined) state[key] = parsed;
  }
  return state;
}

function cloneAndFreezeJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map((entry) => cloneAndFreezeJson(entry)));
  }
  if (typeof value !== "object" || value === null) return value;

  const copy: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    copy[key] = cloneAndFreezeJson(entry);
  }
  return Object.freeze(copy);
}
