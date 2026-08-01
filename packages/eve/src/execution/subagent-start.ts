/**
 * Fresh subagent starts for the runtime-action dispatch step.
 *
 * Every start commits an agent handle (`starting`) before its side
 * effect and confirms it (`running`) once the child reports
 * coordinates, so the returned session owns every child it may have
 * created. Split from the dispatch step so plan classification and
 * dispatch orchestration stay separate concerns.
 */

import type { DispatchOutcome, RuntimeSession } from "#execution/agent-handle-dispatch.js";
import {
  resolveRemoteAgentForAction,
  startRemoteAgentSession,
} from "#execution/remote-agent-dispatch.js";
import { buildSubagentRunInput, type SubagentInputSource } from "#execution/subagent-tool.js";
import { createWorkflowRuntime } from "#execution/workflow-runtime.js";
import { REMOTE_AGENT_START_FAILED, SUBAGENT_START_FAILED } from "#harness/agent-handle-errors.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import { deriveAgentId, type AgentIdentity, type StartOperation } from "#harness/handles/store.js";
import {
  confirmAgentStarted,
  prepareAgentStart,
  rejectAgentEffect,
} from "#harness/handles/transitions.js";
import { createLogger, logError } from "#internal/logging.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
  RuntimeSubagentDispatchFailure,
} from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("execution.subagent-start");

/** One classified fresh-start target. */
export type DispatchStartTarget =
  | {
      readonly kind: "local";
      readonly action: RuntimeSubagentCallActionRequest;
      readonly source: SubagentInputSource;
    }
  | { readonly kind: "remote"; readonly action: RuntimeRemoteAgentCallActionRequest };

export async function startSubagent(input: {
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly callbackBaseUrl: string | undefined;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  readonly currentSession: RuntimeSession;
  readonly fanoutSize: number;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly parentContinuationToken: string | undefined;
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
  readonly persistentSessions: boolean;
  readonly session: RuntimeSession;
  readonly target: DispatchStartTarget;
}): Promise<DispatchOutcome> {
  switch (input.target.kind) {
    case "local":
      return startLocalSubagent({
        action: input.target.action,
        auth: input.auth,
        batchEvent: input.batchEvent,
        bundle: input.bundle,
        capabilities: input.capabilities,
        channelMetadata: input.channelMetadata,
        currentSession: input.currentSession,
        fanoutSize: input.fanoutSize,
        initiatorAuth: input.initiatorAuth,
        parentContinuationToken: input.parentContinuationToken,
        parentTraceContext: input.parentTraceContext,
        persistentSessions: input.persistentSessions,
        session: input.session,
        source: input.target.source,
      });
    case "remote":
      return startRemoteSubagent({
        action: input.target.action,
        auth: input.auth,
        batchEvent: input.batchEvent,
        bundle: input.bundle,
        callbackBaseUrl: input.callbackBaseUrl,
        currentSession: input.currentSession,
        initiatorAuth: input.initiatorAuth,
        parentContinuationToken: input.parentContinuationToken,
        persistentSessions: input.persistentSessions,
        session: input.session,
      });
    default: {
      const _exhaustive: never = input.target;
      return _exhaustive;
    }
  }
}

/**
 * Mints the deterministic start operation and identity for one dispatch.
 * All inputs are parent-controlled, so both exist before the child does
 * and a durable replay of the step re-derives the same ownership record.
 */
function mintStartOperation(input: {
  readonly callId: string;
  readonly name: string;
  readonly nodeId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): { readonly identity: AgentIdentity; readonly operation: StartOperation } {
  const operationId = deriveAgentOperationId({
    callId: input.callId,
    parentSessionId: input.parentSessionId,
    parentTurnId: input.parentTurnId,
  });
  return {
    identity: {
      id: deriveAgentId(input.name, operationId),
      name: input.name,
      nodeId: input.nodeId,
    },
    operation: {
      callId: input.callId,
      id: operationId,
      kind: "start",
      parentTurnId: input.parentTurnId,
    },
  };
}

async function startLocalSubagent(input: {
  readonly action: RuntimeSubagentCallActionRequest;
  readonly auth: Parameters<typeof buildSubagentRunInput>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly capabilities: Parameters<typeof buildSubagentRunInput>[0]["capabilities"];
  readonly channelMetadata: Parameters<typeof buildSubagentRunInput>[0]["channelMetadata"];
  readonly currentSession: RuntimeSession;
  readonly fanoutSize: number;
  readonly initiatorAuth: Parameters<typeof buildSubagentRunInput>[0]["initiatorAuth"];
  readonly parentContinuationToken: string | undefined;
  readonly parentTraceContext: Parameters<typeof buildSubagentRunInput>[0]["parentTraceContext"];
  readonly persistentSessions: boolean;
  readonly session: RuntimeSession;
  readonly source: SubagentInputSource;
}): Promise<DispatchOutcome> {
  const { action, source } = input;
  const childRuntime = createWorkflowRuntime({
    compiledArtifactsSource: input.bundle.compiledArtifactsSource,
    nodeId: action.nodeId,
  });
  const { childContinuationToken, runInput } = buildSubagentRunInput({
    action,
    auth: input.auth,
    batchEvent: input.batchEvent,
    capabilities: input.capabilities,
    channelMetadata: input.channelMetadata,
    fanoutSize: input.fanoutSize,
    initiatorAuth: input.initiatorAuth,
    parentContinuationToken: input.parentContinuationToken,
    parentTraceContext: input.parentTraceContext,
    persistentSessions: input.persistentSessions,
    session: input.session,
    source,
  });

  const targetKind = source.type === "runtime" ? ("agent/self" as const) : ("agent/local" as const);
  const { identity, operation } = mintStartOperation({
    callId: action.callId,
    name: action.subagentName,
    nodeId: action.nodeId,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.batchEvent.turnId,
  });
  // Ownership is recorded before the start side effect, and the prepared
  // (or rejected) store rides every outcome into the step result. The
  // guarantee is intra-step: a crash between the accepted start and the
  // step-result commit still replays the whole dispatch step, so the
  // orphan window shrinks to that boundary rather than disappearing.
  const preparedSession = prepareAgentStart(input.currentSession, {
    identity,
    operation,
    target: { continuationToken: childContinuationToken, kind: targetKind },
  });

  let childSessionId: string;
  try {
    const handle = await childRuntime.run(runInput);
    childSessionId = handle.sessionId;
  } catch (error) {
    logError(log, "local subagent start failed", error, {
      callId: action.callId,
      nodeId: action.nodeId,
      subagentName: action.subagentName,
    });
    return {
      kind: "error",
      result: {
        callId: action.callId,
        isError: true,
        kind: "subagent-result",
        output: {
          code: SUBAGENT_START_FAILED,
          message: toErrorMessage(error),
        },
        subagentName: action.subagentName,
      },
      session: rejectAgentEffect(preparedSession, {
        disposition: "dead",
        operationId: operation.id,
      }),
    };
  }

  return {
    callId: action.callId,
    childSessionId,
    kind: "called",
    name: action.name,
    session: confirmAgentStarted(preparedSession, {
      address: {
        continuationToken: childContinuationToken,
        kind: targetKind,
        sessionId: childSessionId,
      },
      operationId: operation.id,
    }),
    toolName: action.subagentName,
  };
}

async function startRemoteSubagent(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly auth: Parameters<typeof startRemoteAgentSession>[0]["auth"];
  readonly batchEvent: { readonly sequence: number; readonly turnId: string };
  readonly bundle: CompiledBundle;
  readonly callbackBaseUrl: string | undefined;
  readonly currentSession: RuntimeSession;
  readonly initiatorAuth: Parameters<typeof startRemoteAgentSession>[0]["initiatorAuth"];
  readonly parentContinuationToken: string | undefined;
  readonly persistentSessions: boolean;
  readonly session: RuntimeSession;
}): Promise<DispatchOutcome> {
  const { action } = input;

  // Preflight resolution failures happen before ownership exists, so they
  // reject without touching the handle store.
  let callbackBaseUrl: string;
  let resolvedRemote: ReturnType<typeof resolveRemoteAgentForAction>;
  try {
    if (input.callbackBaseUrl === undefined) {
      throw new Error("Cannot dispatch remote agent without a callback base URL.");
    }
    callbackBaseUrl = input.callbackBaseUrl;
    resolvedRemote = resolveRemoteAgentForAction({
      nodeId: action.nodeId,
      remoteAgentName: action.remoteAgentName,
      registry: input.bundle.subagentRegistry.subagentsByNodeId,
    });
  } catch (error) {
    logError(log, "remote agent start failed", error, {
      remoteAgentName: action.remoteAgentName,
      nodeId: action.nodeId,
      callId: action.callId,
    });
    return {
      kind: "error",
      result: createRemoteAgentStartFailureResult({ action, error }),
      session: input.currentSession,
    };
  }

  const { identity, operation } = mintStartOperation({
    callId: action.callId,
    name: action.remoteAgentName,
    nodeId: action.nodeId,
    parentSessionId: input.session.sessionId,
    parentTurnId: input.batchEvent.turnId,
  });
  const preparedSession = prepareAgentStart(input.currentSession, {
    identity,
    operation,
    target: { callbackBaseUrl, kind: "agent/remote", url: resolvedRemote.url },
  });

  try {
    const child = await startRemoteAgentSession({
      action,
      auth: input.auth,
      callbackBaseUrl,
      callbackToken: input.parentContinuationToken,
      initiatorAuth: input.initiatorAuth,
      persistentSessions: input.persistentSessions,
      remote: resolvedRemote,
      session: input.session,
    });
    return {
      callId: action.callId,
      childSessionId: child.sessionId,
      kind: "called",
      name: action.name,
      remote: { url: resolvedRemote.url },
      session: confirmAgentStarted(preparedSession, {
        address: {
          callbackBaseUrl,
          kind: "agent/remote",
          sessionId: child.sessionId,
          url: resolvedRemote.url,
          ...(child.continuationToken === undefined
            ? {}
            : { continuationToken: child.continuationToken }),
        },
        operationId: operation.id,
      }),
      toolName: action.remoteAgentName,
    };
  } catch (error) {
    logError(log, "remote agent start failed", error, {
      remoteAgentName: action.remoteAgentName,
      nodeId: action.nodeId,
      callId: action.callId,
    });
    return {
      kind: "error",
      result: createRemoteAgentStartFailureResult({ action, error }),
      session: rejectAgentEffect(preparedSession, {
        disposition: "dead",
        operationId: operation.id,
      }),
    };
  }
}

function createRemoteAgentStartFailureResult(input: {
  readonly action: RuntimeRemoteAgentCallActionRequest;
  readonly error: unknown;
}): RuntimeSubagentDispatchFailure {
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    output: {
      code: REMOTE_AGENT_START_FAILED,
      message: toErrorMessage(input.error),
    },
    subagentName: input.action.remoteAgentName,
  };
}
