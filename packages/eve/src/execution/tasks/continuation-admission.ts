import type {
  DispatchOutcome,
  RuntimeAgentHandleAction,
  RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import {
  failDelegatedDispatch,
  settleDelegatedDispatch,
  type DelegatedTask,
} from "#execution/tasks/delegate.js";
import { findConflictingTaskForChildSession } from "#execution/tasks/control-shared.js";
import { AGENT_BUSY, AGENT_UNREACHABLE } from "#harness/agent-handle-errors.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import type { RuntimeSubagentDispatchFailure } from "#runtime/actions/types.js";
import type { JsonValue } from "#shared/json.js";

export type ReservedTaskContinuation = Awaited<ReturnType<typeof settleDelegatedDispatch>>;

/** Returns the task-derived busy result for one persistent-agent continuation. */
export async function checkTaskContinuationAdmission(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly agentId: string;
  readonly parentStepIndex: number;
  readonly parentTurnId: string;
  readonly session: RuntimeSession;
}): Promise<RuntimeSubagentDispatchFailure | undefined> {
  const handle = getAgentHandleStore(input.session.state)?.handles.find(
    (candidate) => candidate.identity.id === input.agentId,
  );
  if (handle?.phase !== "running" && handle?.phase !== "parked") return undefined;
  const conflicting = await findConflictingTaskForChildSession({
    childSessionId: handle.address.sessionId,
    parentStepIndex: input.parentStepIndex,
    parentTurnId: input.parentTurnId,
    session: input.session,
  });
  if (conflicting === undefined) return undefined;
  return {
    callId: input.action.callId,
    isError: true,
    kind: "subagent-result",
    origin: "dispatch",
    output: {
      code: AGENT_BUSY,
      message: `Agent "${input.agentId}" is busy with task "${conflicting.view.taskId}" (${conflicting.view.status}).`,
    },
    subagentName:
      input.action.kind === "remote-agent-call"
        ? input.action.remoteAgentName
        : input.action.subagentName,
  };
}

/** Reserves a persistent child before its ambiguous continuation side effect. */
export async function reserveTaskContinuation(input: {
  readonly action: RuntimeAgentHandleAction;
  readonly agentId: string;
  readonly delegated: DelegatedTask | undefined;
  readonly session: RuntimeSession;
}): Promise<ReservedTaskContinuation | undefined> {
  if (input.delegated === undefined) return undefined;
  const handle = getAgentHandleStore(input.session.state)?.handles.find(
    (candidate) =>
      (candidate.phase === "running" || candidate.phase === "parked") &&
      candidate.identity.id === input.agentId,
  );
  if (handle === undefined || (handle.phase !== "running" && handle.phase !== "parked")) {
    return undefined;
  }
  return settleDelegatedDispatch({
    callId: input.action.callId,
    childSessionId: handle.address.sessionId,
    session: input.session,
    subagentName: handle.identity.name,
    task: input.delegated,
  });
}

/** Terminates definitive failures while retaining ambiguous reservations. */
export async function settleTaskDispatchError(input: {
  readonly agentId: string | undefined;
  readonly delegated: DelegatedTask | undefined;
  readonly outcome: Extract<DispatchOutcome, { readonly kind: "error" }>;
  readonly reserved: ReservedTaskContinuation | undefined;
  readonly session: RuntimeSession;
}): Promise<RuntimeSubagentDispatchFailure> {
  const retainedHandle =
    input.agentId !== undefined &&
    getAgentHandleStore(input.session.state)?.handles.some(
      (handle) => handle.identity.id === input.agentId,
    ) === true;
  const ambiguous =
    input.reserved !== undefined &&
    readErrorCode(input.outcome.result.output) === AGENT_UNREACHABLE &&
    retainedHandle;
  if (input.delegated !== undefined && !ambiguous) {
    await failDelegatedDispatch({ error: input.outcome.result.output, task: input.delegated });
  }
  return input.reserved === undefined
    ? input.outcome.result
    : {
        ...input.outcome.result,
        output: attachTaskId(input.outcome.result.output, input.delegated?.taskId),
      };
}

function attachTaskId(output: JsonValue, taskId: string | undefined): JsonValue {
  if (taskId === undefined) return output;
  return output !== null && typeof output === "object" && !Array.isArray(output)
    ? { ...output, taskId }
    : { error: output, taskId };
}

function readErrorCode(output: JsonValue): string | undefined {
  if (output === null || typeof output !== "object" || Array.isArray(output)) return undefined;
  const code = Reflect.get(output, "code");
  return typeof code === "string" ? code : undefined;
}
