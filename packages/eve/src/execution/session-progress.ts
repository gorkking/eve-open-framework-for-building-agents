export const MAX_PROGRESS_ACTIVITY = 100;
export const MAX_PROGRESS_DEDUPLICATION_IDS = 1_000;
export const MAX_PROGRESS_TEXT_LENGTH = 500;

export type ProgressPhase = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

type TerminalProgressPhase = Extract<ProgressPhase, "completed" | "failed" | "cancelled">;

export interface ProgressReportV1 {
  readonly id: string;
  readonly message: string;
  readonly reportedAt: string;
}

export interface ProgressTurnV1 {
  readonly id: string;
  readonly sequence: number;
  readonly phase: ProgressPhase;
  readonly startedAt: string;
  readonly settledAt?: string;
}

export interface ProgressEntityV1 {
  readonly id: string;
  readonly parentId?: string;
  readonly turnId: string;
  readonly stepIndex?: number;
  readonly kind: "tool" | "subagent" | "remote-agent" | "task" | "skill" | "blocker";
  readonly name: string;
  readonly label: string;
  readonly phase: ProgressPhase;
  readonly depth: number;
  readonly currentReport?: ProgressReportV1;
}

export interface ProgressActivityV1 {
  readonly id: string;
  readonly at: string;
  readonly entityId: string;
  readonly kind: "lifecycle" | "tool" | "delegation" | "blocker" | "report";
  readonly label: string;
  readonly phase?: ProgressPhase;
}

/** Complete, bounded presentation state owned by the session driver. */
export interface ProgressSnapshotV1 {
  readonly version: 1;
  readonly revision: number;
  readonly turns: Readonly<Record<string, ProgressTurnV1>>;
  readonly entities: Readonly<Record<string, ProgressEntityV1>>;
  readonly recentActivity: readonly ProgressActivityV1[];
  readonly seenCommandIds: readonly string[];
  readonly seenEventIds: readonly string[];
}

/** Driver-owned presentation boundary; renderers receive no turn or channel context. */
export interface SessionProgressHandler {
  handleProgress(command: ProgressCommandV1): Promise<void>;
}

export interface ProgressCommandV1 {
  readonly kind: "progress";
  readonly version: 1;
  readonly commandId: string;
  readonly events: readonly ProgressEventV1[];
}

export type ProgressEventV1 =
  | {
      readonly kind: "turn";
      readonly eventId: string;
      readonly turn: ProgressTurnV1;
    }
  | {
      readonly kind: "entity";
      readonly eventId: string;
      readonly entity: ProgressEntityV1;
      readonly at: string;
    }
  | {
      readonly kind: "report";
      readonly eventId: string;
      readonly entityId: string;
      readonly report: ProgressReportV1;
    };

export function createProgressSnapshot(): ProgressSnapshotV1 {
  return {
    entities: {},
    recentActivity: [],
    revision: 0,
    seenCommandIds: [],
    seenEventIds: [],
    turns: {},
    version: 1,
  };
}

/**
 * Applies a progress command exactly once. Terminal lifecycle state is
 * monotonic, so late retries and reports cannot reopen settled work.
 */
export function reduceProgressCommand(
  snapshot: ProgressSnapshotV1,
  command: ProgressCommandV1,
): ProgressSnapshotV1 {
  if (snapshot.seenCommandIds.includes(command.commandId)) return snapshot;

  let next: ProgressSnapshotV1 = {
    ...snapshot,
    seenCommandIds: appendBounded(snapshot.seenCommandIds, command.commandId),
  };
  for (const event of command.events) {
    if (next.seenEventIds.includes(event.eventId)) continue;
    next = reduceEvent(next, event);
    next = { ...next, seenEventIds: appendBounded(next.seenEventIds, event.eventId) };
  }
  return next.seenEventIds.length === snapshot.seenEventIds.length
    ? next
    : { ...next, revision: next.revision + 1 };
}

function reduceEvent(snapshot: ProgressSnapshotV1, event: ProgressEventV1): ProgressSnapshotV1 {
  switch (event.kind) {
    case "turn": {
      const current = snapshot.turns[event.turn.id];
      if (current !== undefined && isTerminal(current.phase)) return snapshot;
      const turn = current === undefined ? event.turn : { ...current, ...event.turn };
      return addActivity(
        { ...snapshot, turns: { ...snapshot.turns, [turn.id]: turn } },
        lifecycleActivity(event.eventId, turn.id, turn.startedAt, "lifecycle", turn.id, turn.phase),
      );
    }
    case "entity": {
      const current = snapshot.entities[event.entity.id];
      if (current !== undefined && isTerminal(current.phase)) return snapshot;
      const entity = current === undefined ? event.entity : { ...current, ...event.entity };
      return addActivity(
        { ...snapshot, entities: { ...snapshot.entities, [entity.id]: entity } },
        lifecycleActivity(
          event.eventId,
          entity.id,
          event.at,
          activityKind(entity.kind),
          entity.label,
          entity.phase,
        ),
      );
    }
    case "report": {
      const entity = snapshot.entities[event.entityId];
      if (entity === undefined || isTerminal(entity.phase)) return snapshot;
      const report = { ...event.report, message: normalizeProgressText(event.report.message) };
      return addActivity(
        {
          ...snapshot,
          entities: { ...snapshot.entities, [entity.id]: { ...entity, currentReport: report } },
        },
        lifecycleActivity(event.eventId, entity.id, report.reportedAt, "report", report.message),
      );
    }
  }
}

function addActivity(
  snapshot: ProgressSnapshotV1,
  activity: ProgressActivityV1,
): ProgressSnapshotV1 {
  return {
    ...snapshot,
    recentActivity: appendBounded(snapshot.recentActivity, activity, MAX_PROGRESS_ACTIVITY),
  };
}

function lifecycleActivity(
  id: string,
  entityId: string,
  at: string,
  kind: ProgressActivityV1["kind"],
  label: string,
  phase?: ProgressPhase,
): ProgressActivityV1 {
  return { at, entityId, id, kind, label: normalizeProgressText(label), phase };
}

function activityKind(kind: ProgressEntityV1["kind"]): ProgressActivityV1["kind"] {
  if (kind === "tool" || kind === "skill") return "tool";
  if (kind === "subagent" || kind === "remote-agent" || kind === "task") return "delegation";
  return "blocker";
}

function isTerminal(phase: ProgressPhase): phase is TerminalProgressPhase {
  return phase === "completed" || phase === "failed" || phase === "cancelled";
}

function appendBounded<T>(
  items: readonly T[],
  item: T,
  max = MAX_PROGRESS_DEDUPLICATION_IDS,
): readonly T[] {
  return [...items, item].slice(-max);
}

/** Collapses control characters and whitespace before untrusted text reaches a renderer. */
export function normalizeProgressText(text: string): string {
  return text
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PROGRESS_TEXT_LENGTH);
}
