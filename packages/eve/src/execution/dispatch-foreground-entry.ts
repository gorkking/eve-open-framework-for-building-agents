/**
 * Foreground (joined) dispatch of one resume/start plan entry: the child
 * reports straight back to the parent turn via `parentContinuationToken`,
 * and the originating call's key resolves only when the child settles.
 *
 * Shared by the plain dispatch step (its whole loop) and the task-mode step
 * (entries the model did not launch with `background: true`).
 */

import {
  type DispatchOutcome,
  dispatchToAgentHandle,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import { createAgentContinuationBundle } from "#execution/agent-continuation-bundle.js";
import {
  type DispatchPlanEntry,
  emitSubagentCalled,
  type PreparedRuntimeActionDispatch,
  startSubagent,
} from "#execution/dispatch-runtime-actions-shared.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

export async function dispatchForegroundEntry(input: {
  readonly callbackBaseUrl: string | undefined;
  readonly currentSession: RuntimeSession;
  readonly entry: Extract<DispatchPlanEntry, { readonly kind: "resume" | "start" }>;
  readonly parentContinuationToken: string | undefined;
  readonly persistentSessions: boolean;
  readonly prepared: PreparedRuntimeActionDispatch;
  readonly writer: WritableStreamDefaultWriter<Uint8Array>;
}): Promise<{ readonly result?: RuntimeActionResult; readonly session: RuntimeSession }> {
  const { entry, prepared } = input;
  let outcome: DispatchOutcome;
  switch (entry.kind) {
    case "resume":
      outcome = await dispatchToAgentHandle({
        action: entry.action,
        agentId: entry.agentId,
        bundle: createAgentContinuationBundle({
          action: entry.action,
          bundle: prepared.bundle,
          dynamicRemoteAgent: entry.dynamicRemoteAgent,
        }),
        currentSession: input.currentSession,
        parentToken: input.parentContinuationToken ?? prepared.session.continuationToken,
        parentTurnId: prepared.batch.event.turnId,
      });
      break;
    case "start":
      outcome = await startSubagent({
        auth: prepared.auth,
        batchEvent: prepared.batch.event,
        bundle: prepared.bundle,
        callbackBaseUrl: input.callbackBaseUrl,
        capabilities: prepared.capabilities,
        channelMetadata: prepared.channelMetadata,
        currentSession: input.currentSession,
        fanoutSize: prepared.fanoutSize,
        initiatorAuth: prepared.initiatorAuth,
        parentContinuationToken: input.parentContinuationToken,
        parentTraceContext: prepared.parentTraceContext,
        persistentSessions: input.persistentSessions,
        sandboxSessionId: prepared.sandboxSessionId,
        serializedContext: prepared.serializedContext,
        session: prepared.session,
        taskOwned: false,
        target: entry.target,
      });
      break;
  }

  if (outcome.kind === "error") {
    return { result: outcome.result, session: outcome.session };
  }

  await emitSubagentCalled({
    adapter: prepared.adapter,
    adapterCtx: prepared.adapterCtx,
    batchEvent: prepared.batch.event,
    entry,
    outcome,
    sessionId: prepared.session.sessionId,
    writer: input.writer,
  });
  return { session: outcome.session };
}
