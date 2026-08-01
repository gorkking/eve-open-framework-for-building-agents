import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import {
  cancelRemoteAgentTurn,
  resolveRemoteAgentForAction,
} from "#execution/remote-agent-dispatch.js";
import {
  readLatestTaskSnapshot,
  sendTaskCommand,
  startTaskRun,
} from "#execution/tasks/run-control.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { getAgentHandleStore, type AgentHandle } from "#harness/handles/store.js";
import { createLogger, logError } from "#internal/logging.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeSubagentChildResult,
  RuntimeToolCallActionRequest,
} from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import {
  TASK_CANCEL_TOOL_NAME,
  TASK_CONTROL_TOOL_NAMES,
  TASK_PEEK_TOOL_NAME,
} from "#runtime/framework-tools/tasks.js";
import type { JsonValue } from "#shared/json.js";
import { taskViewsToJson } from "#tasks/json.js";
import {
  findSessionTaskEntry,
  recordSessionTask,
  type SessionTaskIndexEntry,
} from "#tasks/session-index.js";
import { deriveTaskCommandToken, deriveTaskId } from "#tasks/task-id.js";
import { isReadyTaskStatus, type TaskView } from "#tasks/types.js";

const log = createLogger("execution.tasks.dispatch");

const CANCEL_COMMIT_POLL_ATTEMPTS = 10;
const CANCEL_COMMIT_POLL_DELAY_MS = 250;

/** A prepared delegated task: identity plus its started durable run. */
export interface DelegatedTask {
  readonly commandToken: string;
  readonly taskId: string;
  readonly taskRunId: string;
}

/** True for `task_peek` / `task_cancel` calls. */
export function isTaskControlAction(
  action: RuntimeActionRequest,
): action is RuntimeToolCallActionRequest {
  return action.kind === "tool-call" && TASK_CONTROL_TOOL_NAMES.has(action.toolName);
}

/**
 * Creates the durable task record for one delegated subagent call,
 * before the child dispatch side effect. The task must exist first so
 * a fast child always finds a live command hook; a duplicate replay
 * re-derives the same token and the loser exits on the hook claim.
 */
export async function beginDelegatedTask(input: {
  readonly callId: string;
  readonly mode: "local" | "remote";
  readonly name: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
}): Promise<DelegatedTask> {
  const taskId = deriveTaskId({
    callId: input.callId,
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
  });
  const commandToken = deriveTaskCommandToken({
    parentContinuationToken: input.session.continuationToken,
    taskId,
  });
  const run = await startTaskRun({
    commandToken,
    initialView: {
      metadata: { kind: "subagent", mode: input.mode, name: input.name },
      status: "working",
      taskId,
    },
    wakeToken: input.session.continuationToken,
  });
  return { commandToken, taskId, taskRunId: run.runId };
}

/**
 * Settles a delegated dispatch that acknowledged a child: attaches the
 * child session to the task, records the task in the session index, and
 * returns the receipt that resolves the originating tool call.
 *
 * The receipt carries a `parked` outcome so the existing resolve path
 * settles the agent handle to `parked` — the handle keeps the child
 * address for follow-ups while the task run owns the outstanding work.
 */
export async function settleDelegatedDispatch(input: {
  readonly callId: string;
  readonly childSessionId: string;
  readonly session: RuntimeSession;
  readonly subagentName: string;
  readonly task: DelegatedTask;
}): Promise<{ readonly receipt: RuntimeSubagentChildResult; readonly session: RuntimeSession }> {
  // The freshly started task run may not have registered its hook yet;
  // ride out that startup window instead of dropping the acknowledgement.
  await sendTaskCommand({
    command: { childSessionId: input.childSessionId, kind: "describe" },
    commandToken: input.task.commandToken,
    retryUnreachable: { attempts: 20, delayMs: 250 },
  });
  const receiptOutput = { status: "working", taskId: input.task.taskId };
  return {
    receipt: {
      callId: input.callId,
      kind: "subagent-result",
      origin: "child",
      outcome: {
        kind: "parked",
        result: {
          kind: "succeeded",
          output: `Delegated as background task ${input.task.taskId} (working).`,
        },
        usageDelta: { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 },
      },
      output: receiptOutput,
      subagentName: input.subagentName,
    },
    session: recordSessionTask(input.session, {
      commandToken: input.task.commandToken,
      taskId: input.task.taskId,
      taskRunId: input.task.taskRunId,
    }),
  };
}

/**
 * Terminates the task record for a dispatch that never acknowledged a
 * child. The originating call gets the dispatch failure directly; the
 * task fails out of band and is never recorded in the session index,
 * so the model never sees a task id for work that never started.
 */
export async function failDelegatedDispatch(input: {
  readonly error: JsonValue;
  readonly task: DelegatedTask;
}): Promise<void> {
  await sendTaskCommand({
    command: { data: input.error, kind: "fail" },
    commandToken: input.task.commandToken,
    retryUnreachable: { attempts: 20, delayMs: 250 },
  });
}

/**
 * Executes one task-control call inside the dispatch step, which holds
 * the durable session state (ownership index) and world access the
 * tools need.
 */
export async function executeTaskControlAction(input: {
  readonly action: RuntimeToolCallActionRequest;
  readonly bundle: CompiledBundle;
  readonly session: RuntimeSession;
}): Promise<{ readonly result: RuntimeActionResult | undefined }> {
  const { action } = input;
  const taskIds = readTaskIds(action.input);
  if (taskIds === undefined || taskIds.length === 0) {
    return {
      result: createTaskControlError(action, "Provide a non-empty `taskIds` array."),
    };
  }

  const entries: SessionTaskIndexEntry[] = [];
  const unknown: string[] = [];
  for (const taskId of taskIds) {
    const entry = findSessionTaskEntry(input.session.state, taskId);
    if (entry === undefined) {
      unknown.push(taskId);
    } else {
      entries.push(entry);
    }
  }
  if (unknown.length > 0) {
    return {
      result: createTaskControlError(
        action,
        `Unknown task ids: ${unknown.join(", ")}. Tasks belong to the session that created them.`,
      ),
    };
  }

  switch (action.toolName) {
    case TASK_PEEK_TOOL_NAME: {
      const views = await readTaskViews(entries);
      return { result: createTaskViewsResult(action, views) };
    }
    case TASK_CANCEL_TOOL_NAME: {
      const views = await Promise.all(
        entries.map((entry) =>
          cancelOneTask({ bundle: input.bundle, entry, session: input.session }),
        ),
      );
      return { result: createTaskViewsResult(action, views) };
    }
    default:
      return {
        result: createTaskControlError(action, `Unsupported task control "${action.toolName}".`),
      };
  }
}

async function cancelOneTask(input: {
  readonly bundle: CompiledBundle;
  readonly entry: SessionTaskIndexEntry;
  readonly session: RuntimeSession;
}): Promise<TaskView> {
  const { entry } = input;
  await sendTaskCommand({ command: { kind: "cancel" }, commandToken: entry.commandToken });

  // The `cancelled` state must commit before the executor abort
  // propagates, so a late child result can never revive the task.
  let view = await readLatestTaskSnapshot({ taskRunId: entry.taskRunId });
  for (
    let attempt = 0;
    attempt < CANCEL_COMMIT_POLL_ATTEMPTS &&
    !(view !== undefined && isReadyTaskStatus(view.status));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, CANCEL_COMMIT_POLL_DELAY_MS));
    view = await readLatestTaskSnapshot({ taskRunId: entry.taskRunId });
  }
  const settledView = view ?? createPendingTaskView(entry.taskId);

  if (settledView.status === "cancelled") {
    await propagateTaskCancel({ bundle: input.bundle, session: input.session, view: settledView });
  }
  return settledView;
}

/**
 * Best-effort cooperative abort of the cancelled task's child turn,
 * routed through the agent handle that owns the child address. A task
 * whose handle is already gone has nothing left to abort.
 */
async function propagateTaskCancel(input: {
  readonly bundle: CompiledBundle;
  readonly session: RuntimeSession;
  readonly view: TaskView;
}): Promise<void> {
  const childSessionId = input.view.metadata.childSessionId;
  if (childSessionId === undefined) return;
  const handles = getAgentHandleStore(input.session.state)?.handles ?? [];
  const handle = handles
    .filter(
      (candidate): candidate is Extract<AgentHandle, { phase: "running" | "parked" }> =>
        candidate.phase === "running" || candidate.phase === "parked",
    )
    .find((candidate) => candidate.address.sessionId === childSessionId);

  try {
    if (handle !== undefined && handle.address.kind === "agent/remote") {
      const resolved = resolveRemoteAgentForAction({
        nodeId: handle.identity.nodeId,
        remoteAgentName: handle.identity.name,
        registry: input.bundle.subagentRegistry.subagentsByNodeId,
      });
      await cancelRemoteAgentTurn({
        remote: { ...resolved, url: handle.address.url },
        sessionId: childSessionId,
      });
      return;
    }
    await requestWorkflowTurnCancellation({ sessionId: childSessionId });
  } catch (error) {
    logError(log, "task cancel propagation failed; the child may run to completion", error, {
      childSessionId,
      taskId: input.view.taskId,
    });
  }
}

async function readTaskViews(entries: readonly SessionTaskIndexEntry[]): Promise<TaskView[]> {
  return Promise.all(
    entries.map(
      async (entry) =>
        (await readLatestTaskSnapshot({ taskRunId: entry.taskRunId })) ??
        createPendingTaskView(entry.taskId),
    ),
  );
}

function createPendingTaskView(taskId: string): TaskView {
  return {
    metadata: { kind: "subagent", mode: "local", name: "unknown" },
    status: "working",
    taskId,
  };
}

function createTaskViewsResult(
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

function createTaskControlError(
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

function readTaskIds(input: Record<string, unknown>): readonly string[] | undefined {
  const value = input.taskIds;
  if (!Array.isArray(value)) return undefined;
  return value.filter((id): id is string => typeof id === "string" && id.trim() !== "");
}
