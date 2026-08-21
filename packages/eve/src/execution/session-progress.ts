import { normalizeProgressText } from "#execution/progress-text.js";

export const MAX_PROGRESS_EVENT_IDS = 1_000;
export const MAX_PROGRESS_EVENTS_PER_BATCH = 100;
export const MAX_PROGRESS_PENDING_SETTLEMENTS = 500;
export const MAX_PROGRESS_ENTITIES = 500;

export type ProgressWorkKind = "root-turn" | "subagent" | "remote-agent" | "task";
export type ProgressWorkPhase = "running" | "completed" | "failed" | "cancelled";
export type ProgressActionKind = "tool" | "skill";
export type ProgressActionPhase = "running" | "completed" | "failed" | "rejected" | "cancelled";
export type ProgressBlockerKind = "approval" | "authorization" | "input";
export type ProgressBlockerPhase = "blocked" | "completed" | "cancelled" | "failed";

export interface ProgressWorkIdentityV1 {
  readonly callId?: string;
  readonly id: string;
  readonly kind: ProgressWorkKind;
  readonly name?: string;
  readonly parentId?: string;
  readonly rootSessionId: string;
  readonly rootTurnId: string;
  readonly sessionId?: string;
  readonly turnId?: string;
}

export interface PendingProgressSettlementV1 {
  readonly entityKind: "action" | "blocker" | "work";
  readonly eventId: string;
  readonly outcome: ProgressActionPhase | ProgressBlockerPhase | ProgressWorkPhase;
  readonly settledAt: string;
}

export interface ProgressWorkV1 extends ProgressWorkIdentityV1 {
  readonly phase: ProgressWorkPhase;
  readonly settledAt?: string;
  readonly startedAt: string;
}

export interface ProgressActionV1 {
  readonly id: string;
  readonly kind: ProgressActionKind;
  readonly name: string;
  readonly parentWorkId: string;
  readonly phase: ProgressActionPhase;
  readonly rootTurnId: string;
  readonly settledAt?: string;
  readonly startedAt: string;
  readonly stepIndex: number;
}

export interface ProgressBlockerV1 {
  readonly id: string;
  readonly kind: ProgressBlockerKind;
  readonly label?: string;
  readonly parentActionId?: string;
  readonly parentWorkId: string;
  readonly phase: ProgressBlockerPhase;
  readonly rootTurnId: string;
  readonly settledAt?: string;
  readonly startedAt: string;
}

export type ProgressEventV1 =
  | {
      readonly eventId: string;
      readonly kind: "work.started";
      readonly startedAt: string;
      readonly work: ProgressWorkIdentityV1;
    }
  | {
      readonly eventId: string;
      readonly kind: "work.settled";
      readonly outcome: Exclude<ProgressWorkPhase, "running">;
      readonly settledAt: string;
      readonly workId: string;
    }
  | {
      readonly action: Omit<ProgressActionV1, "phase" | "settledAt" | "startedAt">;
      readonly eventId: string;
      readonly kind: "action.started";
      readonly startedAt: string;
    }
  | {
      readonly actionId: string;
      readonly eventId: string;
      readonly kind: "action.settled";
      readonly outcome: Exclude<ProgressActionPhase, "running">;
      readonly settledAt: string;
    }
  | {
      readonly blocker: Omit<ProgressBlockerV1, "phase" | "settledAt" | "startedAt">;
      readonly eventId: string;
      readonly kind: "blocker.started";
      readonly startedAt: string;
    }
  | {
      readonly blockerId: string;
      readonly eventId: string;
      readonly kind: "blocker.settled";
      readonly outcome: Exclude<ProgressBlockerPhase, "blocked">;
      readonly settledAt: string;
    };

export interface ProgressBatchV1 {
  readonly events: readonly ProgressEventV1[];
  readonly version: 1;
}

export interface ProgressSnapshotV1 {
  readonly actions: Readonly<Record<string, ProgressActionV1>>;
  readonly blockers: Readonly<Record<string, ProgressBlockerV1>>;
  readonly pendingSettlements: Readonly<Record<string, PendingProgressSettlementV1>>;
  readonly revision: number;
  readonly seenEventIds: readonly string[];
  readonly version: 1;
  readonly work: Readonly<Record<string, ProgressWorkV1>>;
}

export function createProgressSnapshot(): ProgressSnapshotV1 {
  return {
    actions: {},
    blockers: {},
    pendingSettlements: {},
    revision: 0,
    seenEventIds: [],
    version: 1,
    work: {},
  };
}

export function reduceProgressBatch(
  snapshot: ProgressSnapshotV1,
  batch: ProgressBatchV1,
): ProgressSnapshotV1 {
  let state = snapshot;
  let seenEventIds = snapshot.seenEventIds;
  let presentationChanged = false;
  let accepted = false;

  for (const event of batch.events) {
    if (seenEventIds.includes(event.eventId)) continue;
    const next = reduceEvent(state, event);
    if (next === state) continue;
    accepted = true;
    seenEventIds = appendBounded(seenEventIds, event.eventId, MAX_PROGRESS_EVENT_IDS);
    presentationChanged ||= presentationDiffers(state, next);
    state = next;
  }

  if (!accepted) return snapshot;
  if (!presentationChanged) return { ...state, revision: snapshot.revision, seenEventIds };
  return { ...state, revision: snapshot.revision + 1, seenEventIds };
}

function presentationDiffers(left: ProgressSnapshotV1, right: ProgressSnapshotV1): boolean {
  return (
    left.actions !== right.actions || left.blockers !== right.blockers || left.work !== right.work
  );
}

function reduceEvent(snapshot: ProgressSnapshotV1, event: ProgressEventV1): ProgressSnapshotV1 {
  switch (event.kind) {
    case "work.started":
      return startWork(snapshot, event);
    case "work.settled":
      return settleWork(snapshot, event);
    case "action.started":
      return startAction(snapshot, event);
    case "action.settled":
      return settleAction(snapshot, event);
    case "blocker.started":
      return startBlocker(snapshot, event);
    case "blocker.settled":
      return settleBlocker(snapshot, event);
  }
}

function startWork(
  snapshot: ProgressSnapshotV1,
  event: Extract<ProgressEventV1, { readonly kind: "work.started" }>,
): ProgressSnapshotV1 {
  const current = snapshot.work[event.work.id];
  if (current !== undefined) return snapshot;
  const pending = pendingFor(snapshot, "work", event.work.id);
  const parent = event.work.parentId === undefined ? undefined : snapshot.work[event.work.parentId];
  const phase =
    pending?.outcome ??
    (parent !== undefined && parent.phase !== "running" ? "cancelled" : "running");
  const work: ProgressWorkV1 = {
    ...event.work,
    name: event.work.name === undefined ? undefined : normalizeProgressText(event.work.name),
    phase: phase as ProgressWorkPhase,
    settledAt: pending?.settledAt ?? (phase === "cancelled" ? parent?.settledAt : undefined),
    startedAt: event.startedAt,
  };
  return {
    ...snapshot,
    pendingSettlements: removeKey(snapshot.pendingSettlements, pendingKey("work", work.id)),
    work: replaceBounded(snapshot.work, work.id, work),
  };
}

function settleWork(
  snapshot: ProgressSnapshotV1,
  event: Extract<ProgressEventV1, { readonly kind: "work.settled" }>,
): ProgressSnapshotV1 {
  const current = snapshot.work[event.workId];
  if (current === undefined) return retainPending(snapshot, "work", event.workId, event);
  if (current.phase !== "running") return snapshot;
  return {
    ...snapshot,
    actions: cancelOwnedActions(snapshot.actions, event.workId, event.settledAt),
    blockers: cancelOwnedBlockers(snapshot.blockers, event.workId, event.settledAt),
    work: replaceBounded(snapshot.work, event.workId, {
      ...current,
      phase: event.outcome,
      settledAt: event.settledAt,
    }),
  };
}

function startAction(
  snapshot: ProgressSnapshotV1,
  event: Extract<ProgressEventV1, { readonly kind: "action.started" }>,
): ProgressSnapshotV1 {
  if (snapshot.actions[event.action.id] !== undefined) return snapshot;
  const pending = pendingFor(snapshot, "action", event.action.id);
  const parent = snapshot.work[event.action.parentWorkId];
  const phase =
    pending?.outcome ??
    (parent !== undefined && parent.phase !== "running" ? "cancelled" : "running");
  return {
    ...snapshot,
    actions: replaceBounded(snapshot.actions, event.action.id, {
      ...event.action,
      name: normalizeProgressText(event.action.name),
      phase: phase as ProgressActionPhase,
      settledAt: pending?.settledAt ?? (phase === "cancelled" ? parent?.settledAt : undefined),
      startedAt: event.startedAt,
    }),
    pendingSettlements: removeKey(
      snapshot.pendingSettlements,
      pendingKey("action", event.action.id),
    ),
  };
}

function settleAction(
  snapshot: ProgressSnapshotV1,
  event: Extract<ProgressEventV1, { readonly kind: "action.settled" }>,
): ProgressSnapshotV1 {
  const current = snapshot.actions[event.actionId];
  if (current === undefined) return retainPending(snapshot, "action", event.actionId, event);
  if (current.phase !== "running") return snapshot;
  return {
    ...snapshot,
    actions: replaceBounded(snapshot.actions, event.actionId, {
      ...current,
      phase: event.outcome,
      settledAt: event.settledAt,
    }),
  };
}

function startBlocker(
  snapshot: ProgressSnapshotV1,
  event: Extract<ProgressEventV1, { readonly kind: "blocker.started" }>,
): ProgressSnapshotV1 {
  if (snapshot.blockers[event.blocker.id] !== undefined) return snapshot;
  const pending = pendingFor(snapshot, "blocker", event.blocker.id);
  const parent = snapshot.work[event.blocker.parentWorkId];
  const phase =
    pending?.outcome ??
    (parent !== undefined && parent.phase !== "running" ? "cancelled" : "blocked");
  return {
    ...snapshot,
    blockers: replaceBounded(snapshot.blockers, event.blocker.id, {
      ...event.blocker,
      label:
        event.blocker.label === undefined ? undefined : normalizeProgressText(event.blocker.label),
      phase: phase as ProgressBlockerPhase,
      settledAt: pending?.settledAt ?? (phase === "cancelled" ? parent?.settledAt : undefined),
      startedAt: event.startedAt,
    }),
    pendingSettlements: removeKey(
      snapshot.pendingSettlements,
      pendingKey("blocker", event.blocker.id),
    ),
  };
}

function settleBlocker(
  snapshot: ProgressSnapshotV1,
  event: Extract<ProgressEventV1, { readonly kind: "blocker.settled" }>,
): ProgressSnapshotV1 {
  const current = snapshot.blockers[event.blockerId];
  if (current === undefined) return retainPending(snapshot, "blocker", event.blockerId, event);
  if (current.phase !== "blocked") return snapshot;
  return {
    ...snapshot,
    blockers: replaceBounded(snapshot.blockers, event.blockerId, {
      ...current,
      phase: event.outcome,
      settledAt: event.settledAt,
    }),
  };
}

function retainPending(
  snapshot: ProgressSnapshotV1,
  entityKind: PendingProgressSettlementV1["entityKind"],
  entityId: string,
  event: Extract<ProgressEventV1, { readonly kind: `${string}.settled` }>,
): ProgressSnapshotV1 {
  const key = pendingKey(entityKind, entityId);
  if (snapshot.pendingSettlements[key] !== undefined) return snapshot;
  return {
    ...snapshot,
    pendingSettlements: replaceBounded(
      snapshot.pendingSettlements,
      key,
      { entityKind, eventId: event.eventId, outcome: event.outcome, settledAt: event.settledAt },
      MAX_PROGRESS_PENDING_SETTLEMENTS,
    ),
  };
}

function pendingFor(
  snapshot: ProgressSnapshotV1,
  kind: PendingProgressSettlementV1["entityKind"],
  id: string,
): PendingProgressSettlementV1 | undefined {
  return snapshot.pendingSettlements[pendingKey(kind, id)];
}

function pendingKey(kind: PendingProgressSettlementV1["entityKind"], id: string): string {
  return `${kind}:${id}`;
}

function cancelOwnedActions(
  actions: Readonly<Record<string, ProgressActionV1>>,
  parentWorkId: string,
  settledAt: string,
): Readonly<Record<string, ProgressActionV1>> {
  return mapOwned(actions, parentWorkId, (action) =>
    action.phase === "running" ? { ...action, phase: "cancelled", settledAt } : action,
  );
}

function cancelOwnedBlockers(
  blockers: Readonly<Record<string, ProgressBlockerV1>>,
  parentWorkId: string,
  settledAt: string,
): Readonly<Record<string, ProgressBlockerV1>> {
  return mapOwned(blockers, parentWorkId, (blocker) =>
    blocker.phase === "blocked" ? { ...blocker, phase: "cancelled", settledAt } : blocker,
  );
}

function mapOwned<T extends { readonly parentWorkId: string }>(
  values: Readonly<Record<string, T>>,
  parentWorkId: string,
  transform: (value: T) => T,
): Readonly<Record<string, T>> {
  let next = values;
  for (const [id, value] of Object.entries(values)) {
    if (value.parentWorkId !== parentWorkId) continue;
    const transformed = transform(value);
    if (transformed === value) continue;
    if (next === values) next = { ...values };
    (next as Record<string, T>)[id] = transformed;
  }
  return next;
}

function replaceBounded<T>(
  values: Readonly<Record<string, T>>,
  key: string,
  value: T,
  max = MAX_PROGRESS_ENTITIES,
): Readonly<Record<string, T>> {
  const next = { ...values, [key]: value };
  const overflow = Object.keys(next).length - max;
  for (const oldKey of Object.keys(next).slice(0, Math.max(0, overflow))) delete next[oldKey];
  return next;
}

function removeKey<T>(
  values: Readonly<Record<string, T>>,
  key: string,
): Readonly<Record<string, T>> {
  if (values[key] === undefined) return values;
  const next = { ...values };
  delete next[key];
  return next;
}

function appendBounded<T>(values: readonly T[], value: T, max: number): readonly T[] {
  return [...values, value].slice(-max);
}
