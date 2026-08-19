import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

import type {
  DurableDynamicToolMetadata,
  SessionAuth,
  SessionParent,
  SessionTurn,
} from "#context/keys.js";
import type { HarnessSession } from "#harness/types.js";
import type { MemoryScope, MemoryTurnContext, MemoryVisibility } from "#public/memory/index.js";
import {
  readMemoryMessageAttribution,
  type InternalMemoryMessageAttribution,
} from "#shared/memory-message.js";

const MEMORY_SESSION_STATE_KEY = "eve.memory";
const MEMORY_STATE_VERSION = 1;
const EMPTY_VISIBLE_RECALL_FINGERPRINT = fingerprint([]);

export interface DurableMemoryCallbackSession {
  readonly auth: SessionAuth;
  readonly id: string;
  readonly parent?: SessionParent;
  readonly turn: SessionTurn;
}

export interface DurableMemorySlotLock {
  readonly scope: MemoryScope | null;
  readonly slot: string;
  readonly visibility: MemoryVisibility;
}

export interface DurableMemoryTurnState {
  readonly principalIdentity: string;
  readonly session: DurableMemoryCallbackSession;
  readonly slots: readonly DurableMemorySlotLock[];
  readonly toolMetadata: readonly DurableDynamicToolMetadata[];
  readonly turn: MemoryTurnContext;
}

export interface DurableMemoryCompactionState {
  readonly modelId: string;
  readonly ordinal: number;
  readonly session: DurableMemoryCallbackSession;
  readonly slots: readonly DurableMemorySlotLock[];
  readonly standalone: boolean;
  readonly turn: MemoryTurnContext | null;
  readonly usageInputTokens: number | null;
}

export interface DurableMemoryToolOrigin {
  readonly authorizationAttemptIds?: readonly string[];
  readonly callId: string;
  readonly principalIdentity: string;
  readonly toolMetadata: DurableDynamicToolMetadata;
  readonly toolName: string;
  readonly turnState: DurableMemoryTurnState;
}

export interface DurableMemoryState {
  readonly activeTurn: DurableMemoryTurnState | null;
  readonly lastVisibleRecallFingerprint?: string;
  readonly nextCompactionOrdinal: number;
  readonly pendingCompaction: DurableMemoryCompactionState | null;
  readonly toolOrigins: Readonly<Record<string, DurableMemoryToolOrigin>>;
  readonly version: typeof MEMORY_STATE_VERSION;
}

export function getMemoryState(session: HarnessSession): DurableMemoryState {
  const candidate = session.state?.[MEMORY_SESSION_STATE_KEY];
  return isDurableMemoryState(candidate) ? candidate : createEmptyMemoryState();
}

export function setMemoryState(
  session: HarnessSession,
  memory: DurableMemoryState,
): HarnessSession {
  return {
    ...session,
    state: {
      ...session.state,
      [MEMORY_SESSION_STATE_KEY]: memory,
    },
  };
}

export function setActiveMemoryTurn(
  session: HarnessSession,
  activeTurn: DurableMemoryTurnState | null,
): HarnessSession {
  const memory = getMemoryState(session);
  const previousFingerprint =
    memory.activeTurn === null
      ? (memory.lastVisibleRecallFingerprint ?? EMPTY_VISIBLE_RECALL_FINGERPRINT)
      : visibleRecallFingerprint(session.history, memory.activeTurn.slots);

  if (activeTurn === null) {
    return setMemoryState(session, {
      ...memory,
      activeTurn,
      lastVisibleRecallFingerprint: previousFingerprint,
    });
  }

  const nextFingerprint = visibleRecallFingerprint(session.history, activeTurn.slots);
  const updated = setMemoryState(session, {
    ...memory,
    activeTurn,
    lastVisibleRecallFingerprint: nextFingerprint,
  });
  return nextFingerprint === previousFingerprint ? updated : invalidatePromptAccounting(updated);
}

export function getActiveMemoryTurn(session: HarnessSession): DurableMemoryTurnState | null {
  return getMemoryState(session).activeTurn;
}

export function setPendingMemoryCompaction(
  session: HarnessSession,
  pendingCompaction: DurableMemoryCompactionState | null,
  nextCompactionOrdinal?: number,
): HarnessSession {
  const memory = getMemoryState(session);
  return setMemoryState(session, {
    ...memory,
    nextCompactionOrdinal: nextCompactionOrdinal ?? memory.nextCompactionOrdinal,
    pendingCompaction,
  });
}

export function getPendingMemoryCompaction(
  session: HarnessSession,
): DurableMemoryCompactionState | null {
  return getMemoryState(session).pendingCompaction;
}

/** Filters attributed recall messages according to the active operation's slot locks. */
export function projectMemoryMessages(input: {
  readonly messages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): ModelMessage[] {
  const memory = getMemoryState(input.session);
  const slots = memory.pendingCompaction?.slots ?? memory.activeTurn?.slots;
  if (slots === undefined) return [...input.messages];
  return input.messages.filter((message) => {
    const attribution = readMemoryMessageAttribution(message);
    return attribution === null || isRecallVisible(attribution, slots);
  });
}

export function recordMemoryToolOrigins(input: {
  readonly calls: readonly {
    readonly authorizationAttemptIds?: readonly string[];
    readonly callId: string;
    readonly toolName: string;
  }[];
  readonly session: HarnessSession;
}): HarnessSession {
  const memory = getMemoryState(input.session);
  const toolOrigins: Record<string, DurableMemoryToolOrigin> = { ...memory.toolOrigins };

  for (const call of input.calls) {
    const existing = toolOrigins[call.callId];
    if (existing !== undefined) {
      if (call.authorizationAttemptIds !== undefined) {
        toolOrigins[call.callId] = {
          ...existing,
          authorizationAttemptIds: [
            ...new Set([
              ...(existing.authorizationAttemptIds ?? []),
              ...call.authorizationAttemptIds,
            ]),
          ],
        };
      }
      continue;
    }
    const active = memory.activeTurn;
    const toolMetadata = active?.toolMetadata.find((candidate) => candidate.name === call.toolName);
    if (active === null || active === undefined || toolMetadata === undefined) continue;
    toolOrigins[call.callId] = {
      ...call,
      principalIdentity: active.principalIdentity,
      toolMetadata,
      turnState: active,
    };
  }

  return setMemoryState(input.session, { ...memory, toolOrigins });
}

export function getMemoryToolOriginCallIds(
  session: HarnessSession,
  authorizationAttemptIds?: readonly string[],
): string[] {
  const origins = getMemoryState(session).toolOrigins;
  if (authorizationAttemptIds === undefined) return Object.keys(origins).sort(compareStrings);
  const expected = new Set(authorizationAttemptIds);
  return Object.values(origins)
    .filter((origin) => origin.authorizationAttemptIds?.some((id) => expected.has(id)) === true)
    .map((origin) => origin.callId)
    .sort(compareStrings);
}

export function getMemoryToolOrigins(
  session: HarnessSession,
  callIds: readonly string[],
): readonly DurableMemoryToolOrigin[] {
  const origins = getMemoryState(session).toolOrigins;
  return callIds.flatMap((callId) => {
    const origin = origins[callId];
    return origin === undefined ? [] : [origin];
  });
}

export function releaseMemoryToolOrigins(input: {
  readonly callIds: readonly string[];
  readonly session: HarnessSession;
}): HarnessSession {
  const memory = getMemoryState(input.session);
  const toolOrigins: Record<string, DurableMemoryToolOrigin> = { ...memory.toolOrigins };
  for (const callId of input.callIds) delete toolOrigins[callId];
  return setMemoryState(input.session, { ...memory, toolOrigins });
}

export function restoreMemoryTurnFromToolOrigins(input: {
  readonly callIds: readonly string[];
  readonly session: HarnessSession;
}): HarnessSession {
  if (input.callIds.length === 0) return input.session;
  const origins = getMemoryToolOrigins(input.session, input.callIds);
  if (origins.length === 0) return input.session;
  const first = origins[0]!.turnState;
  const expected = durableTurnIdentity(first);
  if (origins.some((origin) => durableTurnIdentity(origin.turnState) !== expected)) {
    throw new Error("Memory tool calls from different originating turns cannot resume together.");
  }
  return setActiveMemoryTurn(input.session, first);
}

function durableTurnIdentity(turn: DurableMemoryTurnState): string {
  return JSON.stringify({
    principalIdentity: turn.principalIdentity,
    sessionId: turn.session.id,
    slots: turn.slots,
    turn: turn.turn,
  });
}

function createEmptyMemoryState(): DurableMemoryState {
  return {
    activeTurn: null,
    lastVisibleRecallFingerprint: EMPTY_VISIBLE_RECALL_FINGERPRINT,
    nextCompactionOrdinal: 0,
    pendingCompaction: null,
    toolOrigins: {},
    version: MEMORY_STATE_VERSION,
  };
}

function isDurableMemoryState(value: unknown): value is DurableMemoryState {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { readonly version?: unknown }).version === MEMORY_STATE_VERSION
  );
}

function isRecallVisible(
  attribution: InternalMemoryMessageAttribution,
  slots: readonly DurableMemorySlotLock[],
): boolean {
  const active = slots.find((candidate) => candidate.slot === attribution.slot);
  return (
    active !== undefined &&
    active.scope !== null &&
    (active.visibility === "session" || attribution.scope.key === active.scope.key)
  );
}

function visibleRecallFingerprint(
  messages: readonly ModelMessage[],
  slots: readonly DurableMemorySlotLock[],
): string {
  return fingerprint(
    messages.flatMap((message, index) => {
      const attribution = readMemoryMessageAttribution(message);
      return attribution !== null && isRecallVisible(attribution, slots)
        ? [{ attribution, content: message.content, index }]
        : [];
    }),
  );
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("base64url");
}

function invalidatePromptAccounting(session: HarnessSession): HarnessSession {
  return {
    ...session,
    compaction: {
      recentWindowSize: session.compaction.recentWindowSize,
      threshold: session.compaction.threshold,
      thresholdPercent: session.compaction.thresholdPercent,
    },
  };
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
