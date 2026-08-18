/**
 * Task-mode sibling of `dispatchRuntimeActionsStep`, selected only when the
 * root agent enables `experimental.tasks`.
 *
 * The launch mode is per call, for fresh starts: a start launched with
 * `background: true` (and every agentId continuation — session exclusivity
 * lives on the task path) starts its transport-specific internal `defineTool`
 * executor as a distinct Workflow run and settles immediately with a task
 * receipt; every other start dispatches on the foreground wire and the
 * turn parks on its result, exactly like plain mode. A background run
 * re-enters the shared task lifecycle only after transport selection, so the
 * durable task run remains the sole lifecycle writer while local hooks and
 * remote HTTP callbacks stay separate. Task-control calls execute inline
 * because they operate on the parent session rather than invoking a subagent.
 */

import { dispatchForegroundEntry } from "#execution/dispatch-foreground-entry.js";
import {
  prepareRuntimeActionDispatch,
  rehydrateRuntimeActionDispatch,
  type RuntimeActionDispatchInput,
  type RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import {
  executeTaskControlAction,
  type PendingTaskJoin,
} from "#execution/tasks/parent/dispatch.js";
import {
  dispatchLocalSubagentWorkflow,
  dispatchRemoteSubagentWorkflow,
  type SubagentWorkflowDispatch,
} from "#execution/tasks/parent/subagent/dispatch.js";
import { isLocalSubagentWorkflowEntry } from "#execution/tasks/parent/subagent/local.js";
import { isRemoteSubagentWorkflowEntry } from "#execution/tasks/parent/subagent/remote.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

export async function dispatchTaskStep(
  input: RuntimeActionDispatchInput,
): Promise<RuntimeActionDispatchResult> {
  "use step";

  const initial = await prepareRuntimeActionDispatch({
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
    taskControls: true,
  });
  if (initial === undefined) {
    return { results: [], sessionState: input.sessionState, pendingTasks: [] };
  }
  let sessionState = input.sessionState;
  const results: RuntimeActionResult[] = [];
  const pendingTasks: Array<RuntimeActionDispatchResult["pendingTasks"][number]> = [];
  const pendingJoins: PendingTaskJoin[] = [];

  for (const entry of initial.plan) {
    if (entry.kind === "reject") {
      results.push(entry.result);
      continue;
    }

    if (entry.kind === "task-control") {
      const prepared = await rehydrateRuntimeActionDispatch({
        fanoutSize: initial.fanoutSize,
        plan: initial.plan,
        serializedContext: input.serializedContext,
        sessionState,
      });
      if (prepared === undefined) {
        throw new Error(
          `Task dispatch lost its pending batch before call "${entry.action.callId}".`,
        );
      }
      const control = await executeTaskControlAction({
        action: entry.action,
        bundle: prepared.bundle,
        parentStepIndex: prepared.batch.event.stepIndex,
        parentTurnId: prepared.batch.event.turnId,
        session: prepared.session,
      });
      if (control.result !== undefined) results.push(control.result);
      if (control.pendingTask !== undefined) pendingTasks.push(control.pendingTask);
      if (control.pendingJoin !== undefined) pendingJoins.push(control.pendingJoin);
      if (control.session !== prepared.session) {
        sessionState = createDurableSessionState({ session: control.session });
      }
      continue;
    }

    // Per-call launch mode, fresh starts only: a start the model did not
    // launch with `background: true` dispatches on the foreground wire and
    // the turn parks on its result, exactly like plain mode. Continuations
    // always take the task path — session exclusivity (AGENT_BUSY) is
    // enforced there and a foreground resume of a task-owned session would
    // bypass it.
    if (entry.kind === "start" && entry.target.action.input.background !== true) {
      const prepared = await rehydrateRuntimeActionDispatch({
        fanoutSize: initial.fanoutSize,
        plan: initial.plan,
        serializedContext: input.serializedContext,
        sessionState,
      });
      if (prepared === undefined) {
        throw new Error(
          `Task dispatch lost its pending batch before foreground call "${entry.target.action.callId}".`,
        );
      }
      // Acquired per entry: the background arm's child workflow takes this
      // writer itself, so a loop-wide hold would deadlock a mixed batch.
      const writer = input.parentWritable.getWriter();
      try {
        const foreground = await dispatchForegroundEntry({
          callbackBaseUrl: input.callbackBaseUrl,
          currentSession: prepared.session,
          entry,
          parentContinuationToken: input.parentContinuationToken,
          // Tasks imply the persistent-session capability; foreground
          // children stay continuable by agentId like every tasks-mode child.
          persistentSessions: true,
          prepared,
          writer,
        });
        if (foreground.result !== undefined) {
          results.push(foreground.result);
        }
        if (foreground.session !== prepared.session) {
          sessionState = createDurableSessionState({ session: foreground.session });
        }
      } finally {
        writer.releaseLock();
      }
      continue;
    }

    let dispatched: SubagentWorkflowDispatch;
    if (isLocalSubagentWorkflowEntry(entry)) {
      dispatched = await dispatchLocalSubagentWorkflow({
        entry,
        fanoutSize: initial.fanoutSize,
        runtimeInput: { ...input, sessionState },
      });
    } else if (isRemoteSubagentWorkflowEntry(entry)) {
      dispatched = await dispatchRemoteSubagentWorkflow({
        entry,
        fanoutSize: initial.fanoutSize,
        runtimeInput: { ...input, sessionState },
      });
    } else {
      throw new Error("Task dispatch produced an unclassified subagent transport.");
    }
    results.push(...dispatched.result.results);
    pendingTasks.push(...dispatched.result.pendingTasks);
    sessionState = dispatched.result.sessionState;
  }

  return { pendingJoins, pendingTasks, results, sessionState };
}
