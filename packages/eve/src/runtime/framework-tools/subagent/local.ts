import { loadContext } from "#context/container.js";
import { HandleEventKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import {
  dispatchToTaskAgentAddress,
  type DispatchOutcome,
  type RuntimeSession,
} from "#execution/agent-handle-dispatch.js";
import { createAgentContinuationBundle } from "#execution/agent-continuation-bundle.js";
import {
  prepareAgentActionDispatch,
  startSubagent,
} from "#execution/dispatch-runtime-actions-shared.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import {
  checkTaskContinuationAvailability,
  describeTaskDispatch,
} from "#execution/tasks/parent/continuation-dispatch.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import {
  readBackgroundTask,
  readBackgroundToolBatch,
  readBackgroundToolSession,
  stageBackgroundToolEffect,
} from "#execution/tasks/parent/tool-execution.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/handles/state-key.js";
import type { AgentHandle, AgentHandleStore } from "#harness/handles/store.js";
import type { HarnessSession } from "#harness/types.js";
import { defineTool, type TaskExec, type ToolContext } from "#public/definitions/tool.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#runtime/actions/types.js";
import { SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA } from "#runtime/framework-tools/tasks.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { parseJsonObject } from "#shared/json.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { findSessionTaskEntry, recordSessionTask } from "#tasks/session-index.js";
import { createSubagentCalledEvent } from "#protocol/message.js";
import { workflowEntryReference } from "#execution/workflow-runtime.js";
import { createLogger, logError } from "#internal/logging.js";

type SubagentCallAction = RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest;

interface SubagentDefinitionInput {
  readonly description: string;
  readonly name: string;
  readonly nodeId: string;
}

interface SubagentDispatchInput {
  readonly action: SubagentCallAction;
  readonly callbackBaseUrl?: string;
  readonly event: {
    readonly sequence: number;
    readonly stepIndex: number;
    readonly turnId: string;
  };
  readonly localFanoutSize: number;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: ReturnType<typeof createDurableSessionState>;
  readonly task: ReturnType<typeof readBackgroundTask>;
}

interface SubagentDispatchResult {
  readonly address: Extract<DispatchOutcome, { readonly kind: "called" }>["address"];
  readonly agentId: string;
  readonly mode: "local" | "remote";
  readonly name: string;
  readonly remote?: { readonly resolverId: string; readonly url: string };
  readonly session: RuntimeSession;
}

const localSubagentExecutors = new WeakSet<object>();
const log = createLogger("runtime.framework-tools.subagent");

export function defineSubagent(input: SubagentDefinitionInput) {
  const definition = defineTool({
    description: input.description,
    execution: "background",
    inputSchema: PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA,
    outputSchema: SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA,
    execute: (toolInput, ctx, task) =>
      executeSubagentTool({ definition: input, kind: "local", task, toolContext: ctx, toolInput }),
  });
  return definition;
}

export function registerLocalSubagentExecutor(execute: object): void {
  localSubagentExecutors.add(execute);
}

export function countLocalSubagentCalls(
  calls: readonly { readonly definition: { readonly execute: object } }[],
): number {
  return calls.filter((call) => localSubagentExecutors.has(call.definition.execute)).length;
}

export async function executeSubagentTool(input: {
  readonly definition: SubagentDefinitionInput;
  readonly kind: "local" | "remote";
  readonly task: TaskExec;
  readonly toolContext: ToolContext;
  readonly toolInput: unknown;
}) {
  const ctx = loadContext();
  const session = readBackgroundToolSession(input.task);
  const task = readBackgroundTask(input.task);
  const emission = getHarnessEmissionState(session.state);
  const action = createAction(
    input.toolInput,
    input.toolContext.callId,
    input.definition,
    input.kind,
  );
  const dispatched = await dispatchSubagent({
    action,
    callbackBaseUrl: ctx.get(CallbackBaseUrlKey),
    event: { ...emission, turnId: activeTurnId(emission) },
    localFanoutSize: countLocalSubagents(input.task),
    serializedContext: serializeContext(ctx),
    sessionState: createDurableSessionState({ session }),
    task,
  });
  const executor = {
    data: {
      agentId: dispatched.agentId,
      childSessionId: dispatched.address.sessionId,
      mode: dispatched.mode,
      name: dispatched.name,
    },
    kind: "subagent",
  } as const;
  const bundle = ctx.require(BundleKey);

  stageBackgroundToolEffect(input.task, {
    apply: (current) =>
      mergeSubagentSessionEffect({ current, dispatched: dispatched.session, session }),
    rollback: async () => {
      const sessionWithTask = recordSessionTask(dispatched.session, { ...task, executor });
      const entry = findSessionTaskEntry(sessionWithTask.state, task.taskId);
      if (entry !== undefined) {
        await cancelOwnedTask({ bundle, entry, session: sessionWithTask });
      }
    },
  });
  await emitSubagentCalled({
    callId: input.toolContext.callId,
    childSessionId: dispatched.address.sessionId,
    event: { ...emission, turnId: activeTurnId(emission) },
    name: dispatched.name,
    remote: dispatched.remote,
    sessionId: session.sessionId,
    toolName: input.definition.name,
  });

  return input.task.delegated({
    executor,
    receipt: { agentId: dispatched.agentId },
  });
}

async function dispatchSubagent(input: SubagentDispatchInput): Promise<SubagentDispatchResult> {
  const prepared = await prepareAgentActionDispatch({
    action: input.action,
    event: input.event,
    localFanoutSize: input.localFanoutSize,
    serializedContext: input.serializedContext,
    sessionState: input.sessionState,
  });
  const entry = prepared.plan[0];
  if (entry === undefined || entry.kind === "task-control") {
    throw new Error("Subagent tool dispatch produced no executable plan entry.");
  }
  if (entry.kind === "reject") {
    throw new Error(JSON.stringify(entry.result.output));
  }

  if (entry.kind === "resume") {
    const busy = await checkTaskContinuationAvailability({
      action: entry.action,
      agentId: entry.agentId,
      parentStepIndex: input.event.stepIndex,
      parentTurnId: input.event.turnId,
      session: prepared.session,
    });
    if (busy !== undefined) throw new Error(JSON.stringify(busy.output));
  }

  const outcome =
    entry.kind === "resume"
      ? await dispatchToTaskAgentAddress({
          action: entry.action,
          agentId: entry.agentId,
          bundle: createAgentContinuationBundle({
            action: entry.action,
            bundle: prepared.bundle,
            dynamicRemoteAgent: entry.dynamicRemoteAgent,
          }),
          currentSession: prepared.session,
          parentToken: input.task.taskInboxToken,
        })
      : await startSubagent({
          auth: prepared.auth,
          batchEvent: input.event,
          bundle: prepared.bundle,
          callbackBaseUrl: input.callbackBaseUrl,
          capabilities: prepared.capabilities,
          channelMetadata: prepared.channelMetadata,
          currentSession: prepared.session,
          fanoutSize: prepared.fanoutSize,
          initiatorAuth: prepared.initiatorAuth,
          parentContinuationToken: input.task.taskInboxToken,
          parentTraceContext: prepared.parentTraceContext,
          persistentSessions: true,
          sandboxSessionId: prepared.sandboxSessionId,
          serializedContext: prepared.serializedContext,
          session: prepared.session,
          taskOwned: true,
          target: entry.target,
        });
  if (outcome.kind === "error") throw new Error(JSON.stringify(outcome.result.output));

  const described = describeTaskDispatch({
    action: input.action,
    agentId: entry.kind === "resume" ? entry.agentId : undefined,
    parentSessionId: prepared.session.sessionId,
    parentTurnId: input.event.turnId,
    session: outcome.session,
  });
  const dynamicRemoteAgent =
    entry.kind === "resume"
      ? entry.dynamicRemoteAgent
      : entry.target.kind === "remote"
        ? entry.target.dynamicRemoteAgent
        : undefined;
  return {
    address: outcome.address,
    agentId: described.agentId,
    mode: described.mode,
    name: described.name,
    ...(outcome.address.kind === "agent/remote"
      ? {
          remote: {
            resolverId: dynamicRemoteAgent?.credentialsStepId ?? input.action.nodeId,
            url: outcome.address.url,
          },
        }
      : {}),
    session: outcome.session,
  };
}

async function emitSubagentCalled(input: {
  readonly callId: string;
  readonly childSessionId: string;
  readonly event: { readonly sequence: number; readonly turnId: string };
  readonly name: string;
  readonly remote?: { readonly resolverId: string; readonly url: string };
  readonly sessionId: string;
  readonly toolName: string;
}): Promise<void> {
  const handleEvent = loadContext().get(HandleEventKey);
  if (handleEvent === undefined) return;
  try {
    await handleEvent(
      createSubagentCalledEvent({
        callId: input.callId,
        childSessionId: input.childSessionId,
        name: input.name,
        remote: input.remote,
        sequence: input.event.sequence,
        sessionId: input.sessionId,
        toolName: input.toolName,
        turnId: input.event.turnId,
        workflowId: workflowEntryReference.workflowId,
      }),
    );
  } catch (error) {
    logError(log, "subagent.called emission failed", error, {
      callId: input.callId,
      childSessionId: input.childSessionId,
      toolName: input.toolName,
    });
  }
}

function createAction(
  toolInput: unknown,
  callId: string,
  definition: SubagentDefinitionInput,
  kind: "local" | "remote",
): SubagentCallAction {
  const common = {
    callId,
    description: definition.description,
    input: parseJsonObject(PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA.parse(toolInput)),
    name: definition.name,
    nodeId: definition.nodeId,
  };
  return kind === "remote"
    ? {
        ...common,
        kind: "remote-agent-call",
        remoteAgentName: definition.name,
      }
    : { ...common, kind: "subagent-call", subagentName: definition.name };
}

function countLocalSubagents(task: TaskExec): number {
  return countLocalSubagentCalls(readBackgroundToolBatch(task));
}

function mergeSubagentSessionEffect(input: {
  readonly current: HarnessSession;
  readonly dispatched: RuntimeSession;
  readonly session: HarnessSession;
}): HarnessSession {
  const initialHandles = readAgentHandles(input.session);
  const initialIds = new Set(initialHandles.map((handle) => handle.identity.id));
  const dispatchedHandles = readAgentHandles(input.dispatched);
  const dispatchedIds = new Set(dispatchedHandles.map((handle) => handle.identity.id));
  const removedIds = new Set(
    initialHandles
      .filter((handle) => !dispatchedIds.has(handle.identity.id))
      .map((handle) => handle.identity.id),
  );
  const currentHandles = readAgentHandles(input.current).filter(
    (handle) => !removedIds.has(handle.identity.id),
  );
  const currentIds = new Set(currentHandles.map((handle) => handle.identity.id));
  const addedHandles = dispatchedHandles.filter(
    (handle) => !initialIds.has(handle.identity.id) && !currentIds.has(handle.identity.id),
  );
  if (removedIds.size === 0 && addedHandles.length === 0) {
    return {
      ...input.current,
      sandboxState: input.current.sandboxState ?? input.dispatched.sandboxState,
    };
  }
  return {
    ...input.current,
    sandboxState: input.current.sandboxState ?? input.dispatched.sandboxState,
    state: {
      ...input.current.state,
      [AGENT_HANDLES_STATE_KEY]: {
        handles: [...currentHandles, ...addedHandles],
      } satisfies AgentHandleStore,
    },
  };
}

function readAgentHandles(session: HarnessSession | RuntimeSession): readonly AgentHandle[] {
  const raw = session.state?.[AGENT_HANDLES_STATE_KEY];
  if (raw === undefined) return [];
  const handles = (raw as { readonly handles?: unknown }).handles;
  if (!Array.isArray(handles)) throw new Error("Corrupt agent handle session state.");
  return handles as readonly AgentHandle[];
}
