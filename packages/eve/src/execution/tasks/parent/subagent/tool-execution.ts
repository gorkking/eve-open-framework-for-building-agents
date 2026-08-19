import { createHash } from "node:crypto";

import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { SandboxKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import {
  createDurableSessionState,
  type DurableSession,
} from "#execution/durable-session-store.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import { createAgentErrorResult } from "#execution/agent-handle-dispatch.js";
import { findTaskAgentAddress } from "#execution/tasks/parent/control-shared.js";
import type {
  SubagentToolDispatchInput,
  SubagentToolDispatchResult,
} from "#execution/tasks/parent/dispatch-task-step.js";
import { acknowledgeDelegatedTasks } from "#execution/tasks/parent/delegate.js";
import { subagentWorkflowReference } from "#execution/tasks/parent/subagent/workflow-reference.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import {
  AGENT_HANDLES_STATE_KEY,
  assertPersistableAgentHandleStore,
  getAgentHandleStore,
} from "#harness/handles/store.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import type { PendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import { isTurnCancellation } from "#harness/turn-cancellation.js";
import { SUBAGENT_EXECUTION_FAILED } from "#harness/agent-handle-errors.js";
import type { HandleEventFn, HarnessSession, StepResult } from "#harness/types.js";
import { createLogger, logError } from "#internal/logging.js";
import { start } from "#internal/workflow/runtime.js";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type {
  RuntimeActionResult,
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#runtime/actions/types.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { toError } from "#shared/errors.js";
import {
  findSessionTaskEntry,
  getSessionTaskIndex,
  SESSION_TASKS_STATE_KEY,
} from "#tasks/session-index.js";

type SubagentCallAction = RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest;

interface SubagentToolExecutionEffects {
  readonly delegatedTasks: readonly {
    readonly taskInboxToken: string;
    readonly taskId: string;
    readonly taskRunId: string;
  }[];
  readonly session: HarnessSession;
}

interface RegisteredSubagentCall {
  readonly action: SubagentCallAction;
  readonly continuesAgent: boolean;
  readonly dispatchCallId: string;
  readonly result: PromiseWithResolvers<RuntimeActionResult>;
}

const log = createLogger("execution.subagent-tool");
const SubagentToolExecutionKey = new ContextKey<SubagentToolExecutionController>(
  "eve.internal.subagentToolExecution",
);

export async function executeSubagentToolCall(input: {
  readonly action: SubagentCallAction;
}): Promise<unknown> {
  return loadContext().require(SubagentToolExecutionKey).execute(input.action);
}

export async function runWithSubagentToolExecution(input: {
  readonly handleEvent?: HandleEventFn;
  readonly session: HarnessSession;
  readonly step: () => Promise<StepResult>;
}): Promise<StepResult> {
  const ctx = loadContext();
  if (ctx.has(SubagentToolExecutionKey)) {
    throw new Error("Subagent tool execution scope is already active.");
  }
  const controller = new SubagentToolExecutionController(input);
  ctx.setVirtualContext(SubagentToolExecutionKey, controller);
  try {
    try {
      return await controller.apply(await input.step());
    } catch (error) {
      const effects = await controller.readEffects();
      if (effects === undefined) throw error;
      if (isTurnCancellation(error)) {
        throw new SubagentToolExecutionBoundaryError(error, effects);
      }
      await compensateSubagentToolExecutionFailure(effects, error);
      throw error;
    }
  } finally {
    ctx.delete(SubagentToolExecutionKey);
  }
}

export function readSubagentToolExecutionEffects(
  error: unknown,
): SubagentToolExecutionEffects | undefined {
  return error instanceof SubagentToolExecutionBoundaryError ? error.effects : undefined;
}

export function readSubagentToolExecutionCause(error: unknown): unknown {
  return error instanceof SubagentToolExecutionBoundaryError ? error.cause : error;
}

async function compensateSubagentToolExecutionFailure(
  effects: SubagentToolExecutionEffects,
  cause: unknown,
): Promise<void> {
  const bundle = loadContext().require(BundleKey);
  const failures: unknown[] = [];
  for (const task of effects.delegatedTasks) {
    const entry = findSessionTaskEntry(effects.session.state, task.taskId);
    if (entry === undefined) {
      failures.push(
        new Error(`Started task "${task.taskId}" is absent from the parent task index.`),
      );
    } else {
      try {
        await cancelOwnedTask({ bundle, entry, session: effects.session });
      } catch (error) {
        failures.push(error);
      }
    }
    try {
      await acknowledgeDelegatedTasks({ tasks: [task] });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [cause, ...failures],
      "Subagent tool execution failed and its started tasks could not all be settled.",
      { cause },
    );
  }
}

class SubagentToolExecutionBoundaryError extends Error {
  readonly effects: SubagentToolExecutionEffects;

  constructor(cause: unknown, effects: SubagentToolExecutionEffects) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SubagentToolExecutionBoundaryError";
    this.effects = effects;
  }
}

class SubagentToolExecutionController {
  private readonly pendingTasks = new Map<
    string,
    SubagentToolExecutionEffects["delegatedTasks"][number]
  >();
  private readonly callbackBaseUrl?: string;
  private emissionTail: Promise<void> = Promise.resolve();
  private readonly handleEvent?: HandleEventFn;
  private readonly dispatches: Promise<RuntimeActionResult>[] = [];
  private readonly initialSession: HarnessSession;
  private parentSandboxPreparation?: Promise<void>;
  private readonly batchEvent: PendingRuntimeActionBatch["event"];
  private flushScheduled = false;
  private readonly fingerprintOccurrences = new Map<string, number>();
  private readonly registeredCalls: RegisteredSubagentCall[] = [];
  private session: HarnessSession;

  constructor(input: { readonly handleEvent?: HandleEventFn; readonly session: HarnessSession }) {
    this.callbackBaseUrl = loadContext().get(CallbackBaseUrlKey);
    this.handleEvent = input.handleEvent;
    this.batchEvent = getHarnessEmissionState(input.session.state);
    this.initialSession = input.session;
    this.session = input.session;
  }

  async execute(action: SubagentCallAction): Promise<unknown> {
    const requestedAgentId = action.input.agentId;
    const continuesAgent =
      typeof requestedAgentId === "string" &&
      findTaskAgentAddress(this.session, requestedAgentId) !== undefined;
    const result = Promise.withResolvers<RuntimeActionResult>();
    const fingerprint = fingerprintSubagentAction(action);
    const occurrence = this.fingerprintOccurrences.get(fingerprint) ?? 0;
    this.fingerprintOccurrences.set(fingerprint, occurrence + 1);
    const dispatchCallId = `subagent:${this.batchEvent.turnId}:${String(
      this.batchEvent.stepIndex,
    )}:${fingerprint}:${String(occurrence)}`;
    this.registeredCalls.push({ action, continuesAgent, dispatchCallId, result });
    if (!this.flushScheduled) {
      this.flushScheduled = true;
      // AI SDK invokes one response's sibling tool executors synchronously
      // before awaiting them, so the next microtask is the complete fanout.
      queueMicrotask(() => void this.flushRegisteredCalls());
    }
    return this.readResult(await result.promise);
  }

  private readResult(result: RuntimeActionResult): unknown {
    if (result.isError === true) {
      throw new Error(
        typeof result.output === "string" ? result.output : JSON.stringify(result.output),
      );
    }
    return result.output;
  }

  async apply(result: StepResult): Promise<StepResult> {
    await this.settleDispatches();
    const delegatedTasks = [...this.pendingTasks.values()];
    const withSession = {
      ...result,
      session: mergeSubagentDispatchSession({
        current: result.session,
        dispatched: this.session,
        initial: this.initialSession,
      }),
    };
    return delegatedTasks.length === 0
      ? withSession
      : {
          ...withSession,
          delegatedTasks: [...(result.delegatedTasks ?? []), ...delegatedTasks],
        };
  }

  async readEffects(): Promise<SubagentToolExecutionEffects | undefined> {
    await this.settleDispatches();
    const delegatedTasks = [...this.pendingTasks.values()];
    if (delegatedTasks.length === 0) return undefined;
    return { delegatedTasks, session: this.session };
  }

  private async dispatch(
    action: SubagentCallAction,
    continuesAgent: boolean,
    dispatchCallId: string,
    localFanoutSize: number,
  ): Promise<RuntimeActionResult> {
    try {
      if (!continuesAgent) await this.prepareParentSandbox(action);
      const session = this.session;
      const dispatchAction = { ...action, callId: dispatchCallId };
      const workflowInput: SubagentToolDispatchInput = {
        batch: { actions: [dispatchAction], event: this.batchEvent, responseMessages: [] },
        callbackBaseUrl: this.callbackBaseUrl,
        localFanoutSize,
        requireExistingAgent: continuesAgent,
        serializedContext: serializeContext(loadContext()),
        sessionState: createDurableSessionState({ session }),
      };
      const run = await start<[SubagentToolDispatchInput], SubagentToolDispatchResult>(
        subagentWorkflowReference,
        [workflowInput],
      );
      const output = await run.returnValue;
      const dispatched = output.sessionState.snapshot?.session;
      if (dispatched === undefined) {
        throw new Error("Subagent workflow returned no durable session snapshot.");
      }
      this.session = mergeSubagentDispatchSession({
        current: this.session,
        dispatched,
        initial: session,
      });
      for (const task of output.pendingTasks) this.pendingTasks.set(task.taskId, task);
      for (const event of output.calledEvents ?? []) {
        const outwardEvent = {
          ...event,
          data: { ...event.data, callId: action.callId },
        };
        await this.emit(outwardEvent, "subagent.called emission failed", action.callId);
      }

      const dispatchResult = output.results.find(
        (candidate) => candidate.callId === dispatchAction.callId,
      );
      if (dispatchResult === undefined) {
        throw new Error(`Subagent tool call "${dispatchAction.callId}" produced no result.`);
      }
      const result = { ...dispatchResult, callId: action.callId };
      if (
        result.kind === "subagent-result" &&
        result.isError !== true &&
        result.backgroundTask !== undefined
      ) {
        await this.emit(
          {
            data: {
              backgroundTask: result.backgroundTask,
              callId: result.callId,
              output:
                typeof result.output === "string" ? result.output : JSON.stringify(result.output),
              subagentName: result.subagentName,
            },
            type: "subagent.completed",
          },
          "subagent.completed emission failed",
          result.callId,
        );
      }
      await this.emitActionResult(result);
      return result;
    } catch (error) {
      await this.emitActionResult(
        createAgentErrorResult({
          action,
          code: SUBAGENT_EXECUTION_FAILED,
          message: `Subagent dispatch failed: ${toError(error).message}`,
        }),
      );
      throw error;
    }
  }

  private async flushRegisteredCalls(): Promise<void> {
    this.flushScheduled = false;
    const calls = this.registeredCalls.splice(0);
    await this.emitActionsRequested(calls.map(({ action }) => action));
    const localFanoutSize = calls.filter(
      ({ action, continuesAgent }) => action.kind === "subagent-call" && !continuesAgent,
    ).length;
    const activeAgents = new Map<string, Promise<RuntimeActionResult>>();

    for (const call of calls) {
      const requestedAgentId = call.action.input.agentId;
      const agentId =
        call.continuesAgent && typeof requestedAgentId === "string" ? requestedAgentId : undefined;
      const prior = agentId === undefined ? undefined : activeAgents.get(agentId);
      const dispatch =
        prior === undefined
          ? this.dispatch(call.action, call.continuesAgent, call.dispatchCallId, localFanoutSize)
          : prior
              .catch(() => undefined)
              .then(() =>
                this.dispatch(
                  call.action,
                  call.continuesAgent,
                  call.dispatchCallId,
                  localFanoutSize,
                ),
              );
      if (agentId !== undefined) activeAgents.set(agentId, dispatch);
      this.dispatches.push(dispatch);
      void dispatch.then(call.result.resolve, call.result.reject);
    }
  }

  private async prepareParentSandbox(action: SubagentCallAction): Promise<void> {
    if (!sharesParentSandbox(action, loadContext().require(BundleKey))) return;
    if (!loadContext().has(SandboxKey)) return;
    this.parentSandboxPreparation ??= this.initializeParentSandbox();
    await this.parentSandboxPreparation;
  }

  private async initializeParentSandbox(): Promise<void> {
    const sandbox = loadContext().require(SandboxKey);
    await sandbox.get();
    const sandboxState = await sandbox.captureState();
    this.session = { ...this.session, sandboxState };
  }

  private async emitActionsRequested(actions: readonly SubagentCallAction[]): Promise<void> {
    await this.emit(
      createActionsRequestedEvent({
        actions,
        sequence: this.batchEvent.sequence,
        stepIndex: this.batchEvent.stepIndex,
        turnId: this.batchEvent.turnId,
      }),
      "subagent action request emission failed",
    );
  }

  private async emitActionResult(result: RuntimeActionResult): Promise<void> {
    await this.emit(
      createActionResultEvent({
        result,
        sequence: this.batchEvent.sequence,
        stepIndex: this.batchEvent.stepIndex,
        turnId: this.batchEvent.turnId,
      }),
      "subagent action result emission failed",
      result.callId,
    );
  }

  private async emit(
    event: UnstampedMessageStreamEvent,
    message: string,
    callId?: string,
  ): Promise<void> {
    if (this.handleEvent === undefined) return;
    const emission = this.emissionTail.then(async () => {
      try {
        await this.handleEvent?.(event);
      } catch (error) {
        logError(log, message, error, callId === undefined ? undefined : { callId });
      }
    });
    this.emissionTail = emission;
    await emission;
  }

  private async settleDispatches(): Promise<void> {
    await Promise.allSettled(this.dispatches);
  }
}

function fingerprintSubagentAction(action: SubagentCallAction): string {
  const { callId: _callId, ...identity } = action;
  return createHash("sha256")
    .update(JSON.stringify(sortJsonObjectKeys(identity)))
    .digest("hex");
}

function sortJsonObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonObjectKeys);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, entry]) => [key, sortJsonObjectKeys(entry)]),
  );
}

function mergeSubagentDispatchSession(input: {
  readonly current: HarnessSession;
  readonly dispatched: DurableSession;
  readonly initial: HarnessSession;
}): HarnessSession {
  let session = {
    ...input.current,
    sandboxState: input.current.sandboxState ?? input.dispatched.sandboxState,
  };
  const currentTasks = getSessionTaskIndex(session.state);
  const currentTaskIds = new Set(currentTasks.map((entry) => entry.taskId));
  const addedTasks = getSessionTaskIndex(input.dispatched.state).filter(
    (entry) => !currentTaskIds.has(entry.taskId),
  );
  if (addedTasks.length > 0) {
    session = {
      ...session,
      state: {
        ...session.state,
        [SESSION_TASKS_STATE_KEY]: { tasks: [...currentTasks, ...addedTasks] },
      },
    };
  }

  const initialHandles = getAgentHandleStore(input.initial.state)?.handles ?? [];
  const initialHandleIds = new Set(initialHandles.map((handle) => handle.identity.id));
  const dispatchedHandles = getAgentHandleStore(input.dispatched.state)?.handles ?? [];
  const dispatchedHandleIds = new Set(dispatchedHandles.map((handle) => handle.identity.id));
  const removedHandleIds = new Set(
    initialHandles
      .filter((handle) => !dispatchedHandleIds.has(handle.identity.id))
      .map((handle) => handle.identity.id),
  );
  const handles = (getAgentHandleStore(session.state)?.handles ?? []).filter(
    (handle) => !removedHandleIds.has(handle.identity.id),
  );
  const knownHandleIds = new Set(handles.map((handle) => handle.identity.id));
  const addedHandles = dispatchedHandles.filter(
    (handle) =>
      !initialHandleIds.has(handle.identity.id) && !knownHandleIds.has(handle.identity.id),
  );
  if (removedHandleIds.size > 0 || addedHandles.length > 0) {
    session = {
      ...session,
      state: {
        ...session.state,
        [AGENT_HANDLES_STATE_KEY]: assertPersistableAgentHandleStore({
          handles: [...handles, ...addedHandles],
        }),
      },
    };
  }

  return session;
}

function sharesParentSandbox(action: SubagentCallAction, bundle: CompiledBundle): boolean {
  if (action.kind !== "subagent-call") return false;
  const registered = bundle.subagentRegistry.subagentsByNodeId.has(action.nodeId);
  return (
    (action.subagentName === "agent" && !registered) ||
    bundle.graph.nodesByNodeId.get(action.nodeId)?.sandboxRegistry.sandbox.definition
      .inheritsParent === true
  );
}
