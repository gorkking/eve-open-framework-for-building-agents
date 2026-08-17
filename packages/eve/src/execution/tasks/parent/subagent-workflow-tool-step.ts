import { isDeepStrictEqual } from "node:util";

import {
  rehydrateRuntimeActionDispatch,
  type RuntimeActionDispatchInput,
  type RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { dispatchPreparedTaskEntry } from "#execution/tasks/parent/dispatch-task-entry.js";
import type {
  SubagentWorkflowToolEntry,
  SubagentWorkflowToolInput,
} from "#execution/tasks/parent/subagent-workflow-tool.js";

/** Re-enters eve's existing local/remote task dispatcher for one tool call. */
export async function dispatchSubagentWorkflowToolStep(input: {
  readonly entry: SubagentWorkflowToolEntry;
  readonly fanoutSize: number;
  readonly runtimeInput: RuntimeActionDispatchInput;
  readonly toolInput: SubagentWorkflowToolInput;
}): Promise<RuntimeActionDispatchResult> {
  "use step";

  const action = input.entry.kind === "resume" ? input.entry.action : input.entry.target.action;

  const prepared = await rehydrateRuntimeActionDispatch({
    fanoutSize: input.fanoutSize,
    plan: [input.entry],
    serializedContext: input.runtimeInput.serializedContext,
    sessionState: input.runtimeInput.sessionState,
  });
  if (prepared === undefined) {
    throw new Error(`Subagent workflow tool "${action.callId}" has no pending action batch.`);
  }

  const pendingAction = prepared.batch.actions.find(
    (candidate) => candidate.callId === action.callId,
  );
  if (pendingAction === undefined) {
    throw new Error(`Subagent workflow tool call "${action.callId}" is not pending.`);
  }

  if (!isDeepStrictEqual(pendingAction, action)) {
    throw new Error(`Subagent workflow tool call "${action.callId}" changed after planning.`);
  }
  if (!isDeepStrictEqual(action.input, input.toolInput)) {
    throw new Error(`Subagent workflow tool call "${action.callId}" received mismatched input.`);
  }

  const writer = input.runtimeInput.parentWritable.getWriter();
  try {
    const dispatched = await dispatchPreparedTaskEntry({
      currentSession: prepared.session,
      entry: input.entry,
      prepared,
      runtimeInput: input.runtimeInput,
      writer,
    });
    return {
      pendingTasks: dispatched.pendingTask === undefined ? [] : [dispatched.pendingTask],
      results: [dispatched.result],
      sessionState:
        dispatched.session === prepared.session
          ? input.runtimeInput.sessionState
          : createDurableSessionState({ session: dispatched.session }),
    };
  } finally {
    writer.releaseLock();
  }
}
