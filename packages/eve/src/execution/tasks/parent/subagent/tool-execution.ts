import { createHash } from "node:crypto";

import { loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { SandboxKey } from "#context/keys.js";
import { serializeContext } from "#context/serialize.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import { createAgentErrorResult } from "#execution/agent-handle-dispatch.js";
import { findTaskAgentAddress } from "#execution/tasks/parent/control-shared.js";
import type {
  SubagentToolDispatchInput,
  SubagentToolDispatchResult,
} from "#execution/tasks/parent/dispatch-task-step.js";
import { rejectDelegatedDispatch } from "#execution/tasks/parent/delegate.js";
import { reduceSubagentToolExecutionSession } from "#execution/tasks/parent/subagent/session-effects.js";
import { subagentWorkflowReference } from "#execution/tasks/parent/subagent/workflow-reference.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState } from "#harness/emission.js";
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
  createSubagentCalledEvent,
  type UnstampedMessageStreamEvent,
} from "#protocol/message.js";
import type {
  RuntimeActionResult,
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#runtime/actions/types.js";
import { BundleKey, type CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { toError } from "#shared/errors.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";

type SubagentCallAction = RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest;

interface SubagentToolExecutionEffects {
  readonly delegatedTaskSandboxState?: HarnessSession["sandboxState"];
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

interface SubagentDispatchOutcome {
  readonly calledEvents: NonNullable<SubagentToolDispatchResult["calledEvents"]>;
  readonly result: RuntimeActionResult;
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

export function beginSubagentToolExecutionAttempt(): void {
  loadContext().require(SubagentToolExecutionKey).beginAttempt();
}

export function prepareSubagentToolExecutionBatch(input: {
  readonly executableCallIds: readonly string[];
  readonly localFanoutSize: number;
}): void {
  loadContext().require(SubagentToolExecutionKey).prepareBatch(input);
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
      await compensateSubagentToolExecutionFailure(ctx.require(BundleKey), effects, error);
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

export function createSubagentToolExecutionCommitFailureHandler(
  bundle: CompiledBundle,
): (result: StepResult, cause: unknown) => Promise<void> {
  return async (result, cause) => {
    if (result.delegatedTasks === undefined || result.delegatedTasks.length === 0) return;
    await compensateSubagentToolExecutionFailure(
      bundle,
      {
        delegatedTaskSandboxState: result.delegatedTaskSandboxState,
        delegatedTasks: result.delegatedTasks,
        session: result.session,
      },
      cause,
    );
  };
}

async function compensateSubagentToolExecutionFailure(
  bundle: CompiledBundle,
  effects: SubagentToolExecutionEffects,
  cause: unknown,
): Promise<void> {
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
      await rejectDelegatedDispatch({
        error: { code: "PARENT_STEP_FAILED", message: toError(cause).message },
        task,
      });
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
  private readonly handleEvent?: HandleEventFn;
  private readonly dispatches: Promise<void>[] = [];
  private readonly initialSession: HarnessSession;
  private parentSandboxPreparation?: Promise<void>;
  private parentSandboxState?: HarnessSession["sandboxState"];
  private delegatedTaskSandboxState?: HarnessSession["sandboxState"];
  private readonly batchEvent: PendingRuntimeActionBatch["event"];
  private expectedCallIds?: readonly string[];
  private localFanoutSize = 0;
  private readonly fingerprintOccurrences = new Map<string, number>();
  private readonly registeredCalls = new Map<string, RegisteredSubagentCall>();
  private session: HarnessSession;

  constructor(input: { readonly handleEvent?: HandleEventFn; readonly session: HarnessSession }) {
    this.callbackBaseUrl = loadContext().get(CallbackBaseUrlKey);
    this.handleEvent = input.handleEvent;
    const batchEvent = getHarnessEmissionState(input.session.state);
    this.batchEvent = { ...batchEvent, turnId: activeTurnId(batchEvent) };
    this.initialSession = input.session;
    this.session = input.session;
  }

  beginAttempt(): void {
    if (this.dispatches.length > 0) {
      throw new Error(
        "The model call cannot be retried after a subagent tool has started durable work.",
      );
    }
    this.fingerprintOccurrences.clear();
    this.expectedCallIds = undefined;
    this.localFanoutSize = 0;
    this.registeredCalls.clear();
  }

  prepareBatch(input: {
    readonly executableCallIds: readonly string[];
    readonly localFanoutSize: number;
  }): void {
    const callIds = input.executableCallIds;
    if (this.expectedCallIds !== undefined || this.registeredCalls.size > 0) {
      throw new Error("A subagent tool batch is already being registered.");
    }
    if (new Set(callIds).size !== callIds.length) {
      throw new Error("A model response contains duplicate subagent tool-call ids.");
    }
    if (callIds.length === 0) return;
    this.expectedCallIds = callIds;
    this.localFanoutSize = input.localFanoutSize;
    this.flushIfReady();
  }

  async execute(action: SubagentCallAction): Promise<unknown> {
    if (this.expectedCallIds?.includes(action.callId) !== true) {
      throw new Error(
        `Subagent tool call "${action.callId}" is absent from the prepared model response.`,
      );
    }
    const requestedAgentId = action.input.agentId;
    const continuesAgent =
      typeof requestedAgentId === "string" &&
      findTaskAgentAddress(this.session, requestedAgentId) !== undefined;
    const result = Promise.withResolvers<RuntimeActionResult>();
    const fingerprint = fingerprintSubagentAction(action, continuesAgent);
    const occurrence = this.fingerprintOccurrences.get(fingerprint) ?? 0;
    this.fingerprintOccurrences.set(fingerprint, occurrence + 1);
    const dispatchCallId = `subagent:${this.batchEvent.turnId}:${String(
      this.batchEvent.stepIndex,
    )}:${fingerprint}:${String(occurrence)}`;
    if (this.registeredCalls.has(action.callId)) {
      throw new Error(`Subagent tool call "${action.callId}" was registered more than once.`);
    }
    this.registeredCalls.set(action.callId, { action, continuesAgent, dispatchCallId, result });
    this.flushIfReady();
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
      session: reduceSubagentToolExecutionSession({
        current: result.session,
        dispatched: this.session,
        initial: this.initialSession,
      }),
    };
    return delegatedTasks.length === 0
      ? withSession
      : {
          ...withSession,
          delegatedTaskSandboxState: this.delegatedTaskSandboxState,
          delegatedTasks: [...(result.delegatedTasks ?? []), ...delegatedTasks],
        };
  }

  async readEffects(): Promise<SubagentToolExecutionEffects | undefined> {
    await this.settleDispatches();
    const delegatedTasks = [...this.pendingTasks.values()];
    if (delegatedTasks.length === 0) return undefined;
    return {
      delegatedTaskSandboxState: this.delegatedTaskSandboxState,
      delegatedTasks,
      session: this.session,
    };
  }

  private async dispatch(
    action: SubagentCallAction,
    continuesAgent: boolean,
    dispatchCallId: string,
    localFanoutSize: number,
  ): Promise<SubagentDispatchOutcome> {
    const inheritsParentSandbox =
      !continuesAgent && sharesParentSandbox(action, loadContext().require(BundleKey));
    if (inheritsParentSandbox) await this.prepareParentSandbox();
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
    this.session = reduceSubagentToolExecutionSession({
      current: this.session,
      dispatched,
      initial: session,
    });
    for (const task of output.pendingTasks) this.pendingTasks.set(task.taskId, task);
    if (inheritsParentSandbox && output.pendingTasks.length > 0) {
      this.delegatedTaskSandboxState = this.parentSandboxState;
    }

    const result = output.results.find((candidate) => candidate.callId === dispatchAction.callId);
    if (result === undefined) {
      throw new Error(`Subagent tool call "${dispatchAction.callId}" produced no result.`);
    }
    return { calledEvents: output.calledEvents ?? [], result };
  }

  private async projectDispatch(
    action: SubagentCallAction,
    outcome: Promise<SubagentDispatchOutcome>,
  ): Promise<RuntimeActionResult> {
    try {
      const dispatched = await outcome;
      for (const event of dispatched.calledEvents) {
        const outwardEvent = createSubagentCalledEvent({
          ...event.data,
          callId: action.callId,
        });
        await this.emit(outwardEvent, "subagent.called emission failed", action.callId);
      }

      const result = { ...dispatched.result, callId: action.callId };
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

  private flushIfReady(): void {
    if (this.expectedCallIds === undefined) return;
    if (this.expectedCallIds.some((callId) => !this.registeredCalls.has(callId))) return;

    const calls = this.expectedCallIds.map((callId) => this.registeredCalls.get(callId)!);
    const localFanoutSize = this.localFanoutSize;
    this.expectedCallIds = undefined;
    this.localFanoutSize = 0;
    this.registeredCalls.clear();
    const dispatch = this.flushRegisteredCalls(calls, localFanoutSize);
    this.dispatches.push(dispatch);
  }

  private async flushRegisteredCalls(
    calls: readonly RegisteredSubagentCall[],
    localFanoutSize: number,
  ): Promise<void> {
    await this.emitActionsRequested(calls.map(({ action }) => action));
    const activeAgents = new Map<string, Promise<SubagentDispatchOutcome>>();

    const outcomes = calls.map((call) => {
      const requestedAgentId = call.action.input.agentId;
      const agentId =
        call.continuesAgent && typeof requestedAgentId === "string" ? requestedAgentId : undefined;
      const prior = agentId === undefined ? undefined : activeAgents.get(agentId);
      const outcome: Promise<SubagentDispatchOutcome> =
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
      if (agentId !== undefined) activeAgents.set(agentId, outcome);
      return outcome;
    });

    for (const [index, call] of calls.entries()) {
      try {
        call.result.resolve(await this.projectDispatch(call.action, outcomes[index]!));
      } catch (error) {
        call.result.reject(error);
      }
    }
  }

  private async prepareParentSandbox(): Promise<void> {
    if (!loadContext().has(SandboxKey)) return;
    this.parentSandboxPreparation ??= this.initializeParentSandbox();
    await this.parentSandboxPreparation;
  }

  private async initializeParentSandbox(): Promise<void> {
    const sandbox = loadContext().require(SandboxKey);
    await sandbox.get();
    const sandboxState = await sandbox.captureState();
    this.parentSandboxState = sandboxState;
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
    try {
      await this.handleEvent(event);
    } catch (error) {
      logError(log, message, error, callId === undefined ? undefined : { callId });
    }
  }

  private async settleDispatches(): Promise<void> {
    await Promise.allSettled(this.dispatches);
  }
}

function fingerprintSubagentAction(action: SubagentCallAction, continuesAgent: boolean): string {
  const { callId: _callId, ...identity } = action;
  const canonicalIdentity = continuesAgent
    ? identity
    : {
        ...identity,
        input: Object.fromEntries(
          Object.entries(identity.input).filter(([key]) => key !== "agentId"),
        ),
      };
  return createHash("sha256")
    .update(JSON.stringify(sortJsonObjectKeys(canonicalIdentity)))
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

function sharesParentSandbox(action: SubagentCallAction, bundle: CompiledBundle): boolean {
  if (action.kind !== "subagent-call") return false;
  const registered = bundle.subagentRegistry.subagentsByNodeId.has(action.nodeId);
  return (
    (action.subagentName === "agent" && !registered) ||
    bundle.graph.nodesByNodeId.get(action.nodeId)?.sandboxRegistry.sandbox.definition
      .inheritsParent === true
  );
}
