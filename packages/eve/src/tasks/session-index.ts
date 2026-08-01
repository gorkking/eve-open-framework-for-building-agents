import { z } from "#compiled/zod/index.js";

import type { HarnessSession, SessionStateMap } from "#harness/types.js";

/**
 * Session-state key for the parent's live-task index.
 *
 * The parent session stores only this index; the mutable task record
 * lives in the dedicated durable task run. The PR #1190 spike found the
 * session-state boundary unworkable for task state itself: session state
 * threads through step results, while callback routes and child
 * executors must update tasks without holding the current snapshot.
 */
export const SESSION_TASKS_STATE_KEY = "eve.tasks";

/**
 * One task owned by this session.
 *
 * `commandToken` is the private routing credential for the task run's
 * command hook. It must never render into model context, history, task
 * snapshots, or compaction summaries — the model addresses tasks by
 * `taskId` only, and lookup verifies ownership through this index.
 */
export interface SessionTaskIndexEntry {
  readonly taskId: string;
  readonly taskRunId: string;
  readonly commandToken: string;
}

const sessionTaskIndexEntrySchema: z.ZodType<SessionTaskIndexEntry> = z.strictObject({
  commandToken: z.string().min(1),
  taskId: z.string().min(1),
  taskRunId: z.string().min(1),
});

const sessionTaskIndexSchema = z
  .strictObject({
    tasks: z.array(sessionTaskIndexEntrySchema),
  })
  .refine(
    (index) => new Set(index.tasks.map((entry) => entry.taskId)).size === index.tasks.length,
    {
      message: "Task ids must be unique.",
    },
  );

interface SessionTaskIndex {
  readonly tasks: readonly SessionTaskIndexEntry[];
}

/**
 * Reads and validates the task index from session state.
 *
 * A present but invalid index throws: treating corruption as absence
 * would silently orphan every live task's routing credential.
 */
export function getSessionTaskIndex(
  state: SessionStateMap | undefined,
): readonly SessionTaskIndexEntry[] {
  const raw = state?.[SESSION_TASKS_STATE_KEY];
  if (raw === undefined) {
    return [];
  }
  const parsed = sessionTaskIndexSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Corrupt task index under session state key "${SESSION_TASKS_STATE_KEY}": ${parsed.error.message}`,
    );
  }
  return parsed.data.tasks;
}

/** Finds one owned task; `undefined` enforces parent-session ownership. */
export function findSessionTaskEntry(
  state: SessionStateMap | undefined,
  taskId: string,
): SessionTaskIndexEntry | undefined {
  return getSessionTaskIndex(state).find((entry) => entry.taskId === taskId);
}

/**
 * Records one task, replacing any entry with the same id so replayed
 * creation for the same originating call stays idempotent.
 */
export function recordSessionTask(
  session: HarnessSession,
  entry: SessionTaskIndexEntry,
): HarnessSession {
  const existing = getSessionTaskIndex(session.state);
  const tasks = [...existing.filter((candidate) => candidate.taskId !== entry.taskId), entry];
  return {
    ...session,
    state: {
      ...session.state,
      [SESSION_TASKS_STATE_KEY]: { tasks } satisfies SessionTaskIndex,
    },
  };
}
