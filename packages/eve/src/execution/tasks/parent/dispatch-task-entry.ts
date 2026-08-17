import {
  type DispatchOutcome,
  dispatchToTaskAgentAddress,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import { createAgentContinuationBundle } from "#execution/agent-continuation-bundle.js";
import {
  emitSubagentCalled,
  type DispatchPlanEntry,
  type PreparedRuntimeActionDispatch,
  type RuntimeActionDispatchInput,
  startSubagent,
} from "#execution/dispatch-runtime-actions-shared.js";
import {
  beginDelegatedTask,
  type DelegatedTask,
  settleDelegatedDispatch,
} from "#execution/tasks/parent/delegate.js";
import { executeTaskControlAction } from "#execution/tasks/parent/dispatch.js";
import {
  checkTaskContinuationAvailability,
  describeTaskDispatch,
  persistContinuationTaskInParentSession,
  settleTaskDispatchError,
  type PersistedContinuationTask,
} from "#execution/tasks/parent/continuation-dispatch.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

type ExecutableTaskDispatchEntry = Exclude<DispatchPlanEntry, { readonly kind: "reject" }>;

export interface TaskDispatchEntryResult {
  readonly pendingTask?: DelegatedTask;
  readonly result: RuntimeActionResult;
  readonly session: RuntimeSession;
}

/** Executes one already-planned task-mode action inside a durable step. */
export async function dispatchPreparedTaskEntry(input: {
  readonly currentSession: RuntimeSession;
  readonly entry: ExecutableTaskDispatchEntry;
  readonly prepared: PreparedRuntimeActionDispatch;
  readonly runtimeInput: RuntimeActionDispatchInput;
  readonly writer?: WritableStreamDefaultWriter<Uint8Array>;
}): Promise<TaskDispatchEntryResult> {
  const { entry, prepared } = input;
  const { batch, bundle, session } = prepared;

  if (entry.kind === "task-control") {
    const control = await executeTaskControlAction({
      action: entry.action,
      bundle,
      parentStepIndex: batch.event.stepIndex,
      parentTurnId: batch.event.turnId,
      session: input.currentSession,
    });
    return {
      pendingTask: control.pendingTask,
      result: control.result,
      session: control.session,
    };
  }

  const writer = input.writer;
  if (writer === undefined) {
    throw new Error("Subagent task dispatch requires a parent stream writer.");
  }

  if (entry.kind === "resume") {
    const busy = await checkTaskContinuationAvailability({
      action: entry.action,
      agentId: entry.agentId,
      parentStepIndex: batch.event.stepIndex,
      parentTurnId: batch.event.turnId,
      session: input.currentSession,
    });
    if (busy !== undefined) {
      return { result: busy, session: input.currentSession };
    }
  }

  const action = entry.kind === "resume" ? entry.action : entry.target.action;
  const delegated = await beginDelegatedTask({
    ...describeTaskDispatch({
      action,
      agentId: entry.kind === "resume" ? entry.agentId : undefined,
      parentSessionId: session.sessionId,
      parentTurnId: batch.event.turnId,
      session: input.currentSession,
    }),
    parentSessionId: session.sessionId,
    parentStepIndex: batch.event.stepIndex,
    parentTurnId: batch.event.turnId,
    session: input.currentSession,
  });

  let currentSession = input.currentSession;
  let persistedContinuation: PersistedContinuationTask | undefined;
  if (entry.kind === "resume") {
    persistedContinuation = await persistContinuationTaskInParentSession({
      action: entry.action,
      agentId: entry.agentId,
      delegated,
      session: currentSession,
    });
    currentSession = persistedContinuation?.session ?? currentSession;
  }

  let outcome: DispatchOutcome;
  switch (entry.kind) {
    case "resume":
      outcome = await dispatchToTaskAgentAddress({
        action: entry.action,
        agentId: entry.agentId,
        bundle: createAgentContinuationBundle({
          action: entry.action,
          bundle,
          dynamicRemoteAgent: entry.dynamicRemoteAgent,
        }),
        currentSession,
        parentToken: delegated.taskInboxToken,
      });
      break;
    case "start":
      outcome = await startSubagent({
        auth: prepared.auth,
        batchEvent: batch.event,
        bundle,
        callbackBaseUrl: input.runtimeInput.callbackBaseUrl,
        capabilities: prepared.capabilities,
        channelMetadata: prepared.channelMetadata,
        currentSession,
        fanoutSize: prepared.fanoutSize,
        initiatorAuth: prepared.initiatorAuth,
        parentContinuationToken: delegated.taskInboxToken,
        parentTraceContext: prepared.parentTraceContext,
        // Task children must remain addressable after the dispatching turn ends.
        persistentSessions: true,
        serializedContext: prepared.serializedContext,
        session,
        taskOwned: true,
        target: entry.target,
      });
      break;
  }

  currentSession = outcome.session;
  if (outcome.kind === "error") {
    return {
      pendingTask: persistedContinuation === undefined ? undefined : delegated,
      result: await settleTaskDispatchError({
        delegated,
        outcome,
        persisted: persistedContinuation,
      }),
      session: currentSession,
    };
  }

  let result: RuntimeActionResult;
  if (persistedContinuation !== undefined) {
    result = persistedContinuation.receipt;
  } else {
    const settled = await settleDelegatedDispatch({
      callId: outcome.callId,
      session: currentSession,
      subagentName: outcome.toolName,
      task: delegated,
    });
    currentSession = settled.session;
    result = settled.receipt;
  }

  await emitSubagentCalled({
    adapter: prepared.adapter,
    adapterCtx: prepared.adapterCtx,
    batchEvent: batch.event,
    entry,
    outcome,
    sessionId: session.sessionId,
    writer,
  });

  return { pendingTask: delegated, result, session: currentSession };
}
