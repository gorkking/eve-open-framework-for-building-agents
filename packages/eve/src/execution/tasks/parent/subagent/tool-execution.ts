import { contextStorage, loadContext } from "#context/container.js";
import { ContextKey } from "#context/key.js";
import { serializeContext } from "#context/serialize.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { cancelOwnedTask } from "#execution/tasks/parent/dispatch.js";
import type {
  SubagentToolDispatchInput,
  SubagentToolDispatchResult,
} from "#execution/tasks/parent/dispatch-task-step.js";
import { acknowledgeDelegatedTasks } from "#execution/tasks/parent/delegate.js";
import { subagentWorkflowReference } from "#execution/tasks/parent/subagent/workflow-reference.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import type { PendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import { isTurnCancellation } from "#harness/turn-cancellation.js";
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
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";

type SubagentCallAction = RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest;

interface SubagentToolExecutionEffects {
  readonly delegatedTasks: readonly {
    readonly taskInboxToken: string;
    readonly taskId: string;
    readonly taskRunId: string;
  }[];
  readonly session: HarnessSession;
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

export function syncSubagentToolExecution(input: {
  readonly batchEvent: PendingRuntimeActionBatch["event"];
  readonly session: HarnessSession;
  readonly updateSession: (session: HarnessSession) => void;
}): void {
  contextStorage.getStore()?.get(SubagentToolExecutionKey)?.sync(input);
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
  private readonly handleEvent?: HandleEventFn;
  private dispatchStarted = false;
  private dispatchTail: Promise<void> = Promise.resolve();
  private batchEvent: PendingRuntimeActionBatch["event"];
  private session: HarnessSession;
  private updateSession?: (session: HarnessSession) => void;

  constructor(input: { readonly handleEvent?: HandleEventFn; readonly session: HarnessSession }) {
    this.callbackBaseUrl = loadContext().get(CallbackBaseUrlKey);
    this.handleEvent = input.handleEvent;
    this.batchEvent = getHarnessEmissionState(input.session.state);
    this.session = input.session;
  }

  sync(input: {
    readonly batchEvent: PendingRuntimeActionBatch["event"];
    readonly session: HarnessSession;
    readonly updateSession: (session: HarnessSession) => void;
  }): void {
    if (this.dispatchStarted) {
      throw new Error("Cannot update subagent tool execution state after dispatch started.");
    }
    this.batchEvent = input.batchEvent;
    this.session = input.session;
    this.updateSession = input.updateSession;
  }

  async execute(action: SubagentCallAction): Promise<unknown> {
    this.dispatchStarted = true;
    const dispatch = this.dispatchTail.then(() => this.dispatch(action));
    this.dispatchTail = dispatch.then(
      () => undefined,
      () => undefined,
    );
    const result = await dispatch;
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
    if (delegatedTasks.length === 0) return result;
    return {
      ...result,
      delegatedTasks: [...(result.delegatedTasks ?? []), ...delegatedTasks],
    };
  }

  async readEffects(): Promise<SubagentToolExecutionEffects | undefined> {
    await this.settleDispatches();
    const delegatedTasks = [...this.pendingTasks.values()];
    if (delegatedTasks.length === 0) return undefined;
    return { delegatedTasks, session: this.session };
  }

  private async dispatch(action: SubagentCallAction): Promise<RuntimeActionResult> {
    await this.emit(
      createActionsRequestedEvent({
        actions: [action],
        sequence: this.batchEvent.sequence,
        stepIndex: this.batchEvent.stepIndex,
        turnId: this.batchEvent.turnId,
      }),
      "subagent action request emission failed",
    );
    const workflowInput: SubagentToolDispatchInput = {
      batch: { actions: [action], event: this.batchEvent, responseMessages: [] },
      callbackBaseUrl: this.callbackBaseUrl,
      serializedContext: serializeContext(loadContext()),
      sessionState: createDurableSessionState({ session: this.session }),
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
    this.session = {
      ...this.session,
      sandboxState: dispatched.sandboxState,
      state: dispatched.state,
    };
    this.updateSession?.(this.session);
    for (const task of output.pendingTasks) this.pendingTasks.set(task.taskId, task);
    for (const event of output.calledEvents ?? []) {
      await this.emit(event, "subagent.called emission failed", event.data.callId);
    }

    const result = output.results.find((candidate) => candidate.callId === action.callId);
    if (result === undefined) {
      throw new Error(`Subagent tool call "${action.callId}" produced no result.`);
    }
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
    return result;
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
    await this.dispatchTail;
  }
}
