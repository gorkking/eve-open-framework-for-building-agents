import { isDeepStrictEqual } from "node:util";

import {
  rehydrateRuntimeActionDispatch,
  type RuntimeActionDispatchInput,
  type RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { dispatchPreparedTaskEntry } from "#execution/tasks/parent/dispatch-task-entry.js";
import type { LocalSubagentWorkflowEntry } from "#execution/tasks/parent/subagent/local.js";
import type { RemoteSubagentWorkflowEntry } from "#execution/tasks/parent/subagent/remote.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";
import { z } from "#compiled/zod/index.js";

type SubagentWorkflowEntry = LocalSubagentWorkflowEntry | RemoteSubagentWorkflowEntry;
type SubagentWorkflowInput = z.infer<typeof PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA>;

/**
 * Re-enters the shared task lifecycle after a local or remote Workflow
 * definition has selected the transport. The transport assertion keeps this
 * convergence point from silently accepting an entry routed to the wrong tool.
 */
export async function dispatchSubagentWorkflowToolStep(input: {
  readonly entry: SubagentWorkflowEntry;
  readonly fanoutSize: number;
  readonly runtimeInput: RuntimeActionDispatchInput;
  readonly toolInput: SubagentWorkflowInput;
  readonly transport: "local" | "remote";
}): Promise<RuntimeActionDispatchResult> {
  "use step";

  const action = input.entry.kind === "resume" ? input.entry.action : input.entry.target.action;
  const actualTransport =
    input.entry.kind === "start"
      ? input.entry.target.kind
      : input.entry.action.kind === "subagent-call"
        ? "local"
        : "remote";
  if (actualTransport !== input.transport) {
    throw new Error(
      `Subagent workflow transport mismatch: expected ${input.transport}, received ${actualTransport}.`,
    );
  }

  const prepared = await rehydrateRuntimeActionDispatch({
    fanoutSize: input.fanoutSize,
    plan: [input.entry],
    serializedContext: input.runtimeInput.serializedContext,
    sessionState: input.runtimeInput.sessionState,
  });
  if (prepared === undefined) {
    throw new Error(
      `${input.transport} subagent workflow "${action.callId}" has no pending batch.`,
    );
  }

  const pendingAction = prepared.batch.actions.find(
    (candidate) => candidate.callId === action.callId,
  );
  if (pendingAction === undefined) {
    throw new Error(`${input.transport} subagent call "${action.callId}" is not pending.`);
  }
  if (!isDeepStrictEqual(pendingAction, action)) {
    throw new Error(`${input.transport} subagent call "${action.callId}" changed after planning.`);
  }
  if (!isDeepStrictEqual(action.input, input.toolInput)) {
    throw new Error(
      `${input.transport} subagent call "${action.callId}" received mismatched input.`,
    );
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
