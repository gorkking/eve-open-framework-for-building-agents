import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import {
  cancelRemoteAgentTurn,
  resolveRemoteAgentForAction,
} from "#execution/remote-agent-dispatch.js";
import {
  createPendingTaskView,
  createTaskControlError,
  createTaskViewsResult,
  createUnknownTasksError,
  findAddressableHandle,
  lookupTaskEntries,
  readTaskViews,
} from "#execution/tasks/control-shared.js";
import { executeTaskSend } from "#execution/tasks/send.js";
import { readLatestTaskSnapshot, sendTaskCommand } from "#execution/tasks/run-control.js";
import { requestWorkflowTurnCancellation } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";
import type {
  RuntimeActionRequest,
  RuntimeActionResult,
  RuntimeToolCallActionRequest,
} from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import {
  TASK_CANCEL_TOOL_NAME,
  TASK_CONTROL_TOOL_NAMES,
  TASK_PEEK_TOOL_NAME,
  TASK_SEND_TOOL_NAME,
} from "#runtime/framework-tools/tasks.js";
import type { SessionTaskIndexEntry } from "#tasks/session-index.js";
import { isTerminalTaskStatus, type TaskView } from "#tasks/types.js";
import { settleAgentTurn } from "#harness/handles/transitions.js";

export {
  beginDelegatedTask,
  failDelegatedDispatch,
  settleDelegatedDispatch,
  type DelegatedTask,
} from "#execution/tasks/delegate.js";

const log = createLogger("execution.tasks.dispatch");

const CANCEL_COMMIT_POLL_ATTEMPTS = 10;
const CANCEL_COMMIT_POLL_DELAY_MS = 250;

/** True for `task_peek` / `task_cancel` / `task_send` calls. */
export function isTaskControlAction(
  action: RuntimeActionRequest,
): action is RuntimeToolCallActionRequest {
  return action.kind === "tool-call" && TASK_CONTROL_TOOL_NAMES.has(action.toolName);
}

/**
 * Executes one task-control call inside the dispatch step, which holds
 * the durable session state (ownership index) and world access the
 * tools need.
 *
 * Returns the (possibly updated) session: `task_send` follow-ups record
 * new tasks and settle the continued agent handle.
 */
export async function executeTaskControlAction(input: {
  readonly action: RuntimeToolCallActionRequest;
  readonly bundle: CompiledBundle;
  readonly parentStepIndex?: number;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
}): Promise<{
  readonly result: RuntimeActionResult | undefined;
  readonly session: RuntimeSession;
}> {
  const { action, session } = input;

  if (action.toolName === TASK_SEND_TOOL_NAME) {
    return executeTaskSend(input);
  }

  const taskIds = readTaskIds(action.input);
  if (taskIds === undefined || taskIds.length === 0) {
    return {
      result: createTaskControlError(action, "Provide a non-empty `taskIds` array."),
      session,
    };
  }

  const lookup = lookupTaskEntries(session, taskIds);
  if (lookup.kind === "unknown") {
    return { result: createUnknownTasksError(action, lookup.unknown), session };
  }
  const entries = lookup.entries;

  switch (action.toolName) {
    case TASK_PEEK_TOOL_NAME: {
      const views = await readTaskViews(entries);
      return { result: createTaskViewsResult(action, views), session };
    }
    case TASK_CANCEL_TOOL_NAME: {
      let nextSession = session;
      const views: TaskView[] = [];
      for (const entry of entries) {
        const cancelled = await cancelOneTask({
          bundle: input.bundle,
          entry,
          session: nextSession,
        });
        nextSession = cancelled.session;
        views.push(cancelled.view);
      }
      return { result: createTaskViewsResult(action, views), session: nextSession };
    }
    default:
      return {
        result: createTaskControlError(action, `Unsupported task control "${action.toolName}".`),
        session,
      };
  }
}

async function cancelOneTask(input: {
  readonly bundle: CompiledBundle;
  readonly entry: SessionTaskIndexEntry;
  readonly session: RuntimeSession;
}): Promise<{ readonly session: RuntimeSession; readonly view: TaskView }> {
  const { entry } = input;
  const delivery = await sendTaskCommand({
    command: { kind: "cancel" },
    commandToken: entry.commandToken,
  });

  // The `cancelled` state must commit before the executor abort
  // propagates, so a late child result can never revive the task.
  let view = await readLatestTaskSnapshot({ taskRunId: entry.taskRunId });
  for (
    let attempt = 0;
    attempt < CANCEL_COMMIT_POLL_ATTEMPTS &&
    !(view !== undefined && isTerminalTaskStatus(view.status));
    attempt += 1
  ) {
    await new Promise((resolve) => setTimeout(resolve, CANCEL_COMMIT_POLL_DELAY_MS));
    view = await readLatestTaskSnapshot({ taskRunId: entry.taskRunId });
  }
  const settledView = view ?? createPendingTaskView(entry.taskId);

  if (settledView.status === "cancelled" && delivery === "delivered") {
    const session = await propagateTaskCancel({
      bundle: input.bundle,
      entry,
      session: input.session,
      view: settledView,
    });
    return { session, view: settledView };
  }
  return { session: input.session, view: settledView };
}

/**
 * Best-effort cooperative abort of the cancelled task's child turn,
 * routed through the agent handle that owns the child address. A task
 * whose handle is already gone has nothing left to abort.
 */
async function propagateTaskCancel(input: {
  readonly bundle: CompiledBundle;
  readonly entry: SessionTaskIndexEntry;
  readonly session: RuntimeSession;
  readonly view: TaskView;
}): Promise<RuntimeSession> {
  const childSessionId = input.view.metadata.childSessionId;
  const childTurnId = input.view.metadata.childTurnId;
  if (childSessionId === undefined || childSessionId !== input.entry.childSessionId) {
    return input.session;
  }
  const handle = findAddressableHandle(input.session, childSessionId);

  try {
    if (handle !== undefined && handle.address.kind === "agent/remote") {
      const resolved = resolveRemoteAgentForAction({
        nodeId: handle.identity.nodeId,
        remoteAgentName: handle.identity.name,
        registry: input.bundle.subagentRegistry.subagentsByNodeId,
      });
      const cancelInput: {
        remote: typeof resolved;
        sessionId: string;
        taskId: string;
        turnId?: string;
      } = {
        remote: { ...resolved, url: handle.address.url },
        sessionId: childSessionId,
        taskId: input.view.taskId,
      };
      if (childTurnId !== undefined) cancelInput.turnId = childTurnId;
      const result = await cancelRemoteAgentTurn(cancelInput);
      if (result.status === "no_active_turn") {
        await cancelRemoteAgentTurn({
          remote: { ...resolved, url: handle.address.url },
          sessionId: childSessionId,
          taskId: input.view.taskId,
        });
      }
    } else {
      const cancelInput: {
        sessionId: string;
        taskId: string;
        turnId?: string;
      } = {
        sessionId: childSessionId,
        taskId: input.view.taskId,
      };
      if (childTurnId !== undefined) cancelInput.turnId = childTurnId;
      const result = await requestWorkflowTurnCancellation(cancelInput);
      if (result.status === "no_active_turn") {
        await requestWorkflowTurnCancellation({
          sessionId: childSessionId,
          taskId: input.view.taskId,
        });
      }
    }
    const settled = settleAgentTurn(input.session, {
      operationId: input.entry.operationId,
      outcome: {
        kind: "parked",
        result: { kind: "cancelled" },
        usageDelta: {
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
        },
      },
    });
    return settled.kind === "settled" ? settled.session : input.session;
  } catch (error) {
    logError(log, "task cancel propagation failed; the child may run to completion", error, {
      childSessionId,
      taskId: input.view.taskId,
    });
    return input.session;
  }
}

function readTaskIds(input: Record<string, unknown>): readonly string[] | undefined {
  const value = input.taskIds;
  if (!Array.isArray(value)) return undefined;
  return value.filter((id): id is string => typeof id === "string" && id.trim() !== "");
}
