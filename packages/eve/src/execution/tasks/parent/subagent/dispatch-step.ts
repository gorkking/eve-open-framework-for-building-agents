import { isDeepStrictEqual } from "node:util";

import {
  type DispatchOutcome,
  dispatchToTaskAgentAddress,
} from "#execution/agent-handle-dispatch.js";
import { createAgentContinuationBundle } from "#execution/agent-continuation-bundle.js";
import {
  emitSubagentCalled,
  rehydrateRuntimeActionDispatch,
  startSubagent,
  type RuntimeActionDispatchInput,
  type RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import {
  checkTaskContinuationAvailability,
  describeTaskDispatch,
  persistContinuationTaskInParentSession,
  settleTaskDispatchError,
  type PersistedContinuationTask,
} from "#execution/tasks/parent/continuation-dispatch.js";
import {
  beginDelegatedTask,
  type DelegatedTask,
  settleDelegatedDispatch,
} from "#execution/tasks/parent/delegate.js";
import type { LocalSubagentWorkflowEntry } from "#execution/tasks/parent/subagent/local.js";
import type { RemoteSubagentWorkflowEntry } from "#execution/tasks/parent/subagent/remote.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";
import { TASK_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";
import { z } from "#compiled/zod/index.js";

type SubagentWorkflowEntry = LocalSubagentWorkflowEntry | RemoteSubagentWorkflowEntry;
type SubagentWorkflowInput = z.infer<typeof TASK_SUBAGENT_TOOL_INPUT_SCHEMA>;

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

  const { batch, bundle, session } = prepared;
  let currentSession = prepared.session;
  const writer = input.runtimeInput.parentWritable.getWriter();
  try {
    if (input.entry.kind === "resume") {
      const busy = await checkTaskContinuationAvailability({
        action: input.entry.action,
        agentId: input.entry.agentId,
        parentStepIndex: batch.event.stepIndex,
        parentTurnId: batch.event.turnId,
        session: currentSession,
      });
      if (busy !== undefined) {
        return {
          pendingTasks: [],
          results: [busy],
          sessionState: input.runtimeInput.sessionState,
        };
      }
    }

    const delegated = await beginDelegatedTask({
      ...describeTaskDispatch({
        action,
        agentId: input.entry.kind === "resume" ? input.entry.agentId : undefined,
        parentSessionId: session.sessionId,
        parentTurnId: batch.event.turnId,
        session: currentSession,
      }),
      parentSessionId: session.sessionId,
      parentStepIndex: batch.event.stepIndex,
      parentTurnId: batch.event.turnId,
      session: currentSession,
    });

    let persistedContinuation: PersistedContinuationTask | undefined;
    if (input.entry.kind === "resume") {
      persistedContinuation = await persistContinuationTaskInParentSession({
        action: input.entry.action,
        agentId: input.entry.agentId,
        delegated,
        session: currentSession,
      });
      currentSession = persistedContinuation?.session ?? currentSession;
    }

    let outcome: DispatchOutcome;
    switch (input.entry.kind) {
      case "resume":
        outcome = await dispatchToTaskAgentAddress({
          action: input.entry.action,
          agentId: input.entry.agentId,
          bundle: createAgentContinuationBundle({
            action: input.entry.action,
            bundle,
            dynamicRemoteAgent:
              "dynamicRemoteAgent" in input.entry ? input.entry.dynamicRemoteAgent : undefined,
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
          sandboxSessionId: prepared.sandboxSessionId,
          // Task children must remain addressable after the dispatching turn ends.
          persistentSessions: true,
          serializedContext: prepared.serializedContext,
          session,
          taskOwned: true,
          target: input.entry.target,
        });
        break;
    }

    currentSession = outcome.session;
    let pendingTask: DelegatedTask | undefined;
    let result: RuntimeActionResult;
    if (outcome.kind === "error") {
      pendingTask = persistedContinuation === undefined ? undefined : delegated;
      result = await settleTaskDispatchError({
        delegated,
        outcome,
        persisted: persistedContinuation,
      });
    } else {
      pendingTask = delegated;
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
        entry: input.entry,
        outcome,
        sessionId: session.sessionId,
        writer,
      });
    }

    return {
      pendingTasks: pendingTask === undefined ? [] : [pendingTask],
      results: [result],
      sessionState:
        currentSession === prepared.session
          ? input.runtimeInput.sessionState
          : createDurableSessionState({ session: currentSession }),
    };
  } finally {
    writer.releaseLock();
  }
}
