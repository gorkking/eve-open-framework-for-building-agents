import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

import type { SessionAuth, SessionParent, SessionTurn } from "#context/keys.js";
import type { HarnessSession } from "#harness/types.js";
import type {
  MemoryProjection,
  MemoryScope,
  MemoryTurnContext,
  MemoryVisibility,
} from "#public/memory/index.js";

const MEMORY_SESSION_STATE_KEY = "eve.memory";
const MEMORY_STATE_VERSION = 1;

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
  readonly nextStepIndex: number;
  readonly principalIdentity: string;
  readonly session: DurableMemoryCallbackSession;
  readonly slots: readonly DurableMemorySlotLock[];
  readonly turn: MemoryTurnContext;
}

export interface DurableMemoryProjectionState extends MemoryProjection {
  readonly anchorIndex: number | null;
  readonly order: number;
  readonly scopeKey: string;
  readonly slot: string;
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

export interface DurableMemoryToolOperation {
  readonly current: MemoryProjection | null;
  readonly messages: readonly ModelMessage[];
  readonly modelId: string;
  readonly operationId: string;
  readonly principalIdentity: string;
  readonly scope: MemoryScope;
  readonly session: DurableMemoryCallbackSession;
  readonly slot: string;
  readonly stepIndex: number;
  readonly toolNames: readonly string[];
  readonly turn: MemoryTurnContext;
  readonly turnState: DurableMemoryTurnState;
}

export interface DurableMemoryToolOrigin extends DurableMemoryToolOperation {
  readonly authorizationAttemptIds?: readonly string[];
  readonly callId: string;
  readonly toolName: string;
}

export interface DurableMemoryState {
  readonly activeToolOperations: readonly DurableMemoryToolOperation[];
  readonly activeTurn: DurableMemoryTurnState | null;
  readonly lastVisibleProjectionFingerprint?: string;
  readonly nextCompactionOrdinal: number;
  readonly nextProjectionOrder: number;
  readonly pendingCompaction: DurableMemoryCompactionState | null;
  readonly projections: readonly DurableMemoryProjectionState[];
  readonly toolOrigins: Readonly<Record<string, DurableMemoryToolOrigin>>;
  readonly version: typeof MEMORY_STATE_VERSION;
}

export function getMemoryState(session: HarnessSession): DurableMemoryState {
  const candidate = session.state?.[MEMORY_SESSION_STATE_KEY];
  if (!isDurableMemoryState(candidate)) return createEmptyMemoryState();
  return candidate;
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
  const before =
    memory.activeTurn === null
      ? (memory.lastVisibleProjectionFingerprint ?? EMPTY_VISIBLE_PROJECTION_FINGERPRINT)
      : visibleProjectionFingerprint(memory);

  if (activeTurn === null) {
    return setMemoryState(session, {
      ...memory,
      activeTurn,
      lastVisibleProjectionFingerprint: before,
    });
  }

  const next = { ...memory, activeTurn };
  return setMemoryStateWithProjectionAccounting(session, next, before);
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

export function anchorUnanchoredVisibleMemoryProjections(input: {
  readonly anchorIndex: number;
  readonly session: HarnessSession;
  readonly slots: readonly DurableMemorySlotLock[];
}): HarnessSession {
  assertAnchorIndex(input.anchorIndex);
  const memory = getMemoryState(input.session);
  const before = visibleProjectionFingerprint(memory);
  const projections = memory.projections.map((projection) => {
    const anchorIndex = isProjectionVisible(projection, input.slots)
      ? (projection.anchorIndex ?? input.anchorIndex)
      : null;
    return projection.anchorIndex === anchorIndex ? projection : { ...projection, anchorIndex };
  });
  if (projections.every((projection, index) => projection === memory.projections[index])) {
    return input.session;
  }
  return setMemoryStateWithProjectionAccounting(
    input.session,
    { ...memory, projections },
    before,
    true,
  );
}

export function reanchorVisibleMemoryProjections(input: {
  readonly anchorIndex: number;
  readonly session: HarnessSession;
  readonly slots: readonly DurableMemorySlotLock[];
}): HarnessSession {
  assertAnchorIndex(input.anchorIndex);
  const memory = getMemoryState(input.session);
  const before = visibleProjectionFingerprint(memory);
  if (
    !memory.projections.some((projection) => {
      const expected = isProjectionVisible(projection, input.slots) ? input.anchorIndex : null;
      return projection.anchorIndex !== expected;
    })
  ) {
    return input.session;
  }
  const projections = memory.projections.map((projection) => ({
    ...projection,
    anchorIndex: isProjectionVisible(projection, input.slots) ? input.anchorIndex : null,
  }));
  return setMemoryStateWithProjectionAccounting(
    input.session,
    { ...memory, projections },
    before,
    true,
  );
}

export function clearMemoryProjectionAnchors(session: HarnessSession): HarnessSession {
  const memory = getMemoryState(session);
  const before = visibleProjectionFingerprint(memory);
  if (memory.projections.every((projection) => projection.anchorIndex === null)) return session;
  const projections = memory.projections.map((projection) => ({
    ...projection,
    anchorIndex: null,
  }));
  return setMemoryStateWithProjectionAccounting(session, { ...memory, projections }, before, true);
}

export function updateMemoryProjection(input: {
  readonly anchorIndex: number;
  readonly result: MemoryProjection | null | undefined;
  readonly scope: MemoryScope;
  readonly session: HarnessSession;
  readonly slot: string;
}): HarnessSession {
  if (input.result === undefined) return input.session;
  assertAnchorIndex(input.anchorIndex);

  const memory = getMemoryState(input.session);
  const before = visibleProjectionFingerprint(memory);
  const index = memory.projections.findIndex(
    (projection) => projection.slot === input.slot && projection.scopeKey === input.scope.key,
  );

  if (input.result === null) {
    if (index < 0) return input.session;
    const projections = memory.projections.filter((_, candidate) => candidate !== index);
    return setMemoryStateWithProjectionAccounting(
      input.session,
      { ...memory, projections },
      before,
      true,
    );
  }

  if (typeof input.result.content !== "string") {
    throw new TypeError(`Memory provider "${input.slot}" returned a non-string projection.`);
  }
  if (input.result.content.length === 0) {
    throw new TypeError(`Memory provider "${input.slot}" returned an empty projection.`);
  }

  if (index >= 0) {
    const projections = [...memory.projections];
    const current = projections[index]!;
    const anchorIndex = current.anchorIndex ?? input.anchorIndex;
    if (current.content === input.result.content && current.anchorIndex === anchorIndex) {
      return input.session;
    }
    projections[index] = {
      ...current,
      anchorIndex,
      content: input.result.content,
    };
    return setMemoryStateWithProjectionAccounting(
      input.session,
      { ...memory, projections },
      before,
      true,
    );
  }

  return setMemoryStateWithProjectionAccounting(
    input.session,
    {
      ...memory,
      nextProjectionOrder: memory.nextProjectionOrder + 1,
      projections: [
        ...memory.projections,
        {
          anchorIndex: input.anchorIndex,
          content: input.result.content,
          order: memory.nextProjectionOrder,
          scopeKey: input.scope.key,
          slot: input.slot,
        },
      ],
    },
    before,
    true,
  );
}

export function getMemoryProjection(input: {
  readonly scope: MemoryScope;
  readonly session: HarnessSession;
  readonly slot: string;
}): MemoryProjection | null {
  const projection = getMemoryState(input.session).projections.find(
    (candidate) => candidate.slot === input.slot && candidate.scopeKey === input.scope.key,
  );
  return projection === undefined ? null : { content: projection.content };
}

export function projectMemoryMessages(input: {
  readonly messages: readonly ModelMessage[];
  readonly session: HarnessSession;
}): ModelMessage[] {
  const memory = getMemoryState(input.session);
  const active = memory.activeTurn;
  if (active === null) return [...input.messages];

  const projections = memory.projections
    .filter(
      (projection) =>
        projection.anchorIndex !== null && isProjectionVisible(projection, active.slots),
    )
    .sort(compareProjections);
  if (projections.length === 0) return [...input.messages];

  const byAnchor = new Map<number, DurableMemoryProjectionState[]>();
  for (const projection of projections) {
    const anchor = Math.min(projection.anchorIndex!, input.messages.length);
    const entries = byAnchor.get(anchor) ?? [];
    entries.push(projection);
    byAnchor.set(anchor, entries);
  }

  const projected: ModelMessage[] = [];
  for (let index = 0; index <= input.messages.length; index += 1) {
    for (const projection of byAnchor.get(index) ?? []) {
      projected.push({ content: projection.content, role: "user" });
    }
    const message = input.messages[index];
    if (message !== undefined) projected.push(message);
  }
  return projected;
}

export function setActiveMemoryToolOperations(
  session: HarnessSession,
  operations: readonly DurableMemoryToolOperation[],
): HarnessSession {
  const memory = getMemoryState(session);
  return setMemoryState(session, { ...memory, activeToolOperations: operations });
}

export function getActiveMemoryToolOperations(
  session: HarnessSession,
): readonly DurableMemoryToolOperation[] {
  return getMemoryState(session).activeToolOperations;
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
    const operation = memory.activeToolOperations.find((candidate) =>
      candidate.toolNames.includes(call.toolName),
    );
    const existing = toolOrigins[call.callId];
    if (existing !== undefined) {
      const turnState = operation?.turnState ?? memory.activeTurn;
      if (call.authorizationAttemptIds !== undefined || turnState !== null) {
        let updated: DurableMemoryToolOrigin = {
          ...existing,
          turnState: turnState ?? existing.turnState,
        };
        if (call.authorizationAttemptIds !== undefined) {
          updated = {
            ...updated,
            authorizationAttemptIds: [
              ...new Set([
                ...(existing.authorizationAttemptIds ?? []),
                ...call.authorizationAttemptIds,
              ]),
            ],
          };
        }
        toolOrigins[call.callId] = updated;
      }
      continue;
    }
    if (operation === undefined) continue;
    toolOrigins[call.callId] = { ...operation, ...call };
  }

  return setMemoryState(input.session, {
    ...memory,
    activeToolOperations: [],
    toolOrigins,
  });
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
  return setActiveMemoryTurn(input.session, {
    ...first,
    nextStepIndex: Math.max(...origins.map((origin) => origin.turnState.nextStepIndex)),
  });
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
    activeToolOperations: [],
    activeTurn: null,
    lastVisibleProjectionFingerprint: EMPTY_VISIBLE_PROJECTION_FINGERPRINT,
    nextCompactionOrdinal: 0,
    nextProjectionOrder: 0,
    pendingCompaction: null,
    projections: [],
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

function isProjectionVisible(
  projection: DurableMemoryProjectionState,
  slots: readonly DurableMemorySlotLock[],
): boolean {
  const active = slots.find((candidate) => candidate.slot === projection.slot);
  if (active?.scope === null || active === undefined) return false;
  return active.visibility === "session" || projection.scopeKey === active.scope.key;
}

function visibleProjectionFingerprint(memory: DurableMemoryState): string {
  const active = memory.activeTurn;
  if (active === null) return EMPTY_VISIBLE_PROJECTION_FINGERPRINT;
  return fingerprintVisibleProjections(
    memory.projections
      .filter((projection) => projection.anchorIndex !== null)
      .filter((projection) => {
        const slot = active.slots.find((candidate) => candidate.slot === projection.slot);
        return (
          slot?.scope !== null &&
          slot !== undefined &&
          (slot.visibility === "session" || projection.scopeKey === slot.scope.key)
        );
      })
      .sort(compareProjections)
      .map(({ anchorIndex, content, order, scopeKey, slot }) => ({
        anchorIndex,
        content,
        order,
        scopeKey,
        slot,
      })),
  );
}

const EMPTY_VISIBLE_PROJECTION_FINGERPRINT = fingerprintVisibleProjections([]);

function fingerprintVisibleProjections(projections: unknown): string {
  return createHash("sha256").update(JSON.stringify(projections)).digest("base64url");
}

function setMemoryStateWithProjectionAccounting(
  session: HarnessSession,
  memory: DurableMemoryState,
  previousFingerprint: string,
  force = false,
): HarnessSession {
  const fingerprint = visibleProjectionFingerprint(memory);
  const updated = setMemoryState(
    session,
    memory.activeTurn === null
      ? memory
      : { ...memory, lastVisibleProjectionFingerprint: fingerprint },
  );
  if (!force && fingerprint === previousFingerprint) return updated;
  return invalidatePromptAccounting(updated);
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

function compareProjections(
  left: DurableMemoryProjectionState,
  right: DurableMemoryProjectionState,
): number {
  const leftAnchor = left.anchorIndex ?? Number.MAX_SAFE_INTEGER;
  const rightAnchor = right.anchorIndex ?? Number.MAX_SAFE_INTEGER;
  if (leftAnchor !== rightAnchor) return leftAnchor - rightAnchor;
  if (left.order !== right.order) return left.order - right.order;
  return compareStrings(left.slot, right.slot);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertAnchorIndex(value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError("Memory projection anchor must be a non-negative integer.");
  }
}
