import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { readLatestTaskSnapshot } from "#execution/tasks/run-control.js";
import { getAgentHandleStore, type AgentHandle } from "#harness/handles/store.js";
import { settleAgentTurn } from "#harness/handles/transitions.js";
import type { RuntimeActionResult, RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import { taskViewsToJson } from "#tasks/json.js";
import {
  findSessionTaskEntry,
  getSessionTaskIndex,
  type SessionTaskIndexEntry,
} from "#tasks/session-index.js";
import { isTerminalTaskStatus, type TaskView } from "#tasks/types.js";

/**
 * Result and lookup helpers shared by the task-control executors
 * (`task_peek`/`task_await`/`task_cancel` in the dispatch module,
 * `task_send` in its own).
 */

/** Resolves owned index entries, or the ids this session does not own. */
export function lookupTaskEntries(
  session: RuntimeSession,
  taskIds: readonly string[],
):
  | { readonly entries: SessionTaskIndexEntry[]; readonly kind: "found" }
  | { readonly kind: "unknown"; readonly unknown: string[] } {
  const entries: SessionTaskIndexEntry[] = [];
  const unknown: string[] = [];
  for (const taskId of taskIds) {
    const entry = findSessionTaskEntry(session.state, taskId);
    if (entry === undefined) {
      unknown.push(taskId);
    } else {
      entries.push(entry);
    }
  }
  return unknown.length > 0 ? { kind: "unknown", unknown } : { entries, kind: "found" };
}

/** Reads the latest snapshot of every entry, defaulting to `working`. */
export async function readTaskViews(
  entries: readonly SessionTaskIndexEntry[],
): Promise<TaskView[]> {
  return Promise.all(
    entries.map(
      async (entry) =>
        (await readLatestTaskSnapshot({ taskRunId: entry.taskRunId })) ??
        createPendingTaskView(entry.taskId),
    ),
  );
}

/** The view of a run that has not published its first snapshot yet. */
export function createPendingTaskView(taskId: string): TaskView {
  return {
    metadata: { kind: "subagent", mode: "local", name: "unknown" },
    status: "working",
    taskId,
  };
}

/** Finds the handle owning one child session's address, any live phase. */
export function findAddressableHandle(
  session: RuntimeSession,
  childSessionId: string | undefined,
): Extract<AgentHandle, { phase: "running" | "parked" }> | undefined {
  if (childSessionId === undefined) return undefined;
  const handles = getAgentHandleStore(session.state)?.handles ?? [];
  return handles
    .filter(
      (candidate): candidate is Extract<AgentHandle, { phase: "running" | "parked" }> =>
        candidate.phase === "running" || candidate.phase === "parked",
    )
    .find((candidate) => candidate.address.sessionId === childSessionId);
}

/** Finds the task that reserves a child for this batch or is still nonterminal. */
export async function findConflictingTaskForChildSession(input: {
  readonly childSessionId: string;
  readonly parentStepIndex?: number;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
}): Promise<{ readonly entry: SessionTaskIndexEntry; readonly view: TaskView } | undefined> {
  for (const entry of getSessionTaskIndex(input.session.state)) {
    if (entry.childSessionId !== input.childSessionId) continue;
    const view =
      (await readLatestTaskSnapshot({ taskRunId: entry.taskRunId })) ??
      createPendingTaskView(entry.taskId);
    if (
      (entry.createdByTurnId === input.parentTurnId &&
        entry.createdByStepIndex === input.parentStepIndex) ||
      !isTerminalTaskStatus(view.status)
    ) {
      return { entry, view };
    }
  }
  return undefined;
}

/** Applies actual terminal task outcomes to handles left running by task receipts. */
export async function reconcileSettledTaskHandles(
  session: RuntimeSession,
): Promise<RuntimeSession> {
  let nextSession = session;
  for (const entry of getSessionTaskIndex(session.state)) {
    const view = await readLatestTaskSnapshot({ taskRunId: entry.taskRunId });
    if (
      view === undefined ||
      !isTerminalTaskStatus(view.status) ||
      view.metadata.childLifecycle === undefined
    ) {
      continue;
    }
    const result =
      view.status === "completed"
        ? { kind: "succeeded" as const, output: view.lastOutput?.data ?? "" }
        : view.status === "failed"
          ? { error: view.lastOutput?.data ?? "Task failed.", kind: "failed" as const }
          : { kind: "cancelled" as const };
    const settled = settleAgentTurn(nextSession, {
      operationId: entry.operationId,
      outcome: {
        kind: view.metadata.childLifecycle,
        result,
        usageDelta: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
    });
    if (settled.kind === "settled") nextSession = settled.session;
  }
  return nextSession;
}

/** One successful task-control result carrying full task views. */
export function createTaskViewsResult(
  action: RuntimeToolCallActionRequest,
  views: readonly TaskView[],
): RuntimeActionResult {
  return {
    callId: action.callId,
    kind: "tool-result",
    output: taskViewsToJson(views),
    toolName: action.toolName,
  };
}

/** One task-control error the model can act on. */
export function createTaskControlError(
  action: RuntimeToolCallActionRequest,
  message: string,
): RuntimeActionResult {
  return {
    callId: action.callId,
    isError: true,
    kind: "tool-result",
    output: { message },
    toolName: action.toolName,
  };
}

/** The ownership error for ids outside this session's task index. */
export function createUnknownTasksError(
  action: RuntimeToolCallActionRequest,
  unknown: readonly string[],
): RuntimeActionResult {
  return createTaskControlError(
    action,
    `Unknown task ids: ${unknown.join(", ")}. Tasks belong to the session that created them.`,
  );
}
