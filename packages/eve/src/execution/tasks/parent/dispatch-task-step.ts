/**
 * Task-mode sibling of `dispatchRuntimeActionsStep`, selected only when the
 * root agent enables `experimental.tasks`.
 *
 * Local and remote delegations start their transport-specific internal
 * `defineTool` executors as distinct Workflow runs. Each run re-enters the
 * shared task lifecycle only after transport selection, so the durable task
 * run remains the sole lifecycle writer while local hooks and remote HTTP
 * callbacks stay separate. Task-control calls execute inline because they
 * operate on the parent session rather than invoking a subagent.
 */

import {
  prepareRuntimeActionDispatch,
  rehydrateRuntimeActionDispatch,
  type RuntimeActionDispatchInput,
  type RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { executeTaskControlAction } from "#execution/tasks/parent/dispatch.js";
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
  const workflowTools = initial.bundle.subagentRegistry.workflowTools;
  if (workflowTools === undefined) {
    throw new Error("Task dispatch requires registered subagent Workflow tools.");
  }

  let sessionState = input.sessionState;
  const results: RuntimeActionResult[] = [];
  const pendingTasks: Array<RuntimeActionDispatchResult["pendingTasks"][number]> = [];

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
      results.push(control.result);
      if (control.pendingTask !== undefined) pendingTasks.push(control.pendingTask);
      if (control.session !== prepared.session) {
        sessionState = createDurableSessionState({ session: control.session });
      }
      continue;
    }

    let dispatched: SubagentWorkflowDispatch;
    if (isLocalSubagentWorkflowEntry(entry)) {
      dispatched = await dispatchLocalSubagentWorkflow({
        entry,
        fanoutSize: initial.fanoutSize,
        runtimeInput: { ...input, sessionState },
        tool: workflowTools.local,
      });
    } else if (isRemoteSubagentWorkflowEntry(entry)) {
      dispatched = await dispatchRemoteSubagentWorkflow({
        entry,
        fanoutSize: initial.fanoutSize,
        runtimeInput: { ...input, sessionState },
        tool: workflowTools.remote,
      });
    } else {
      throw new Error("Task dispatch produced an unclassified subagent transport.");
    }
    results.push(...dispatched.result.results);
    pendingTasks.push(...dispatched.result.pendingTasks);
    sessionState = dispatched.result.sessionState;
  }

  return { pendingTasks, results, sessionState };
}
