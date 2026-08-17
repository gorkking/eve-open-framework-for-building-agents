/**
 * Task-mode sibling of `dispatchRuntimeActionsStep`, selected only when the
 * root agent enables `experimental.tasks`.
 *
 * Each local or remote delegation starts the internal `defineTool` executor in
 * `subagent-workflow-tool.ts` as a distinct Workflow run. That run re-enters
 * the existing task dispatcher for one model call, so the durable task run
 * remains the sole lifecycle writer and the existing local/remote transports
 * remain authoritative. Task-control calls execute inline because they operate
 * on the parent session rather than invoking a subagent.
 */

import {
  prepareRuntimeActionDispatch,
  rehydrateRuntimeActionDispatch,
  type RuntimeActionDispatchInput,
  type RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { dispatchPreparedTaskEntry } from "#execution/tasks/parent/dispatch-task-entry.js";
import { dispatchSubagentWorkflowTool } from "#execution/tasks/parent/dispatch-subagent-workflow-tool.js";
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
      const dispatched = await dispatchPreparedTaskEntry({
        currentSession: prepared.session,
        entry,
        prepared,
        runtimeInput: { ...input, sessionState },
      });
      results.push(dispatched.result);
      if (dispatched.pendingTask !== undefined) pendingTasks.push(dispatched.pendingTask);
      if (dispatched.session !== prepared.session) {
        sessionState = createDurableSessionState({ session: dispatched.session });
      }
      continue;
    }

    const dispatched = await dispatchSubagentWorkflowTool({
      entry,
      fanoutSize: initial.fanoutSize,
      runtimeInput: { ...input, sessionState },
    });
    results.push(...dispatched.result.results);
    pendingTasks.push(...dispatched.result.pendingTasks);
    sessionState = dispatched.result.sessionState;
  }

  return { pendingTasks, results, sessionState };
}
