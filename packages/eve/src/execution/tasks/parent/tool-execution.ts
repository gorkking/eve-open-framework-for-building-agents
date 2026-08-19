import type { ContextContainer } from "#context/container.js";
import { loadContext } from "#context/container.js";
import type { FrameworkContextProvider } from "#context/provider.js";
import { runStep } from "#context/run-step.js";
import { CallbackBaseUrlKey } from "#harness/authorization.js";
import { isAuthorizationSignal } from "#harness/authorization.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { getHarnessEmissionState } from "#harness/emission.js";
import { isTurnCancellation } from "#harness/turn-cancellation.js";
import type { HarnessSession, StepResult } from "#harness/types.js";
import {
  BackgroundToolExecutorKey,
  type BackgroundExecutableTool,
  type BackgroundToolCall,
  type BackgroundToolCallBatch,
  type BackgroundToolExecutor,
} from "#harness/background-tools.js";
import { createEveCallbackRoutePath } from "#protocol/routes.js";
import { isAsyncIterable } from "#shared/async-iterable.js";
import { parseJsonValue } from "#shared/json.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";
import { createTaskDelegated, isTaskDelegated, type TaskExec } from "#shared/tool-task.js";
import { recordSessionTask } from "#tasks/session-index.js";
import { createWorkflowCallbackUrl } from "#execution/workflow-callback-url.js";
import {
  beginBackgroundTask,
  rejectDelegatedDispatch,
  type BackgroundTask,
} from "#execution/tasks/parent/delegate.js";
import { sendTaskCommand } from "#execution/tasks/parent/run-parent.js";

export interface BackgroundToolEffect {
  readonly apply: (session: HarnessSession) => HarnessSession;
  readonly rollback?: (cause: unknown) => Promise<void>;
}

interface BackgroundToolExecutionRecord {
  readonly batch: BackgroundToolCallBatch;
  readonly effects: BackgroundToolEffect[];
  readonly session: HarnessSession;
  settled: boolean;
  task?: BackgroundTask;
}

interface BackgroundToolStepResult {
  readonly backgroundTaskSession: HarnessSession;
  readonly backgroundTasks: NonNullable<StepResult["backgroundTasks"]>;
}

const taskRecords = new WeakMap<TaskExec, BackgroundToolExecutionRecord>();

export function runBackgroundStep(
  ctx: ContextContainer,
  session: HarnessSession,
  callback: (session: HarnessSession) => Promise<StepResult>,
): Promise<StepResult> {
  return runStep(ctx, session, callback, [backgroundToolExecutionProvider]);
}

export const backgroundToolExecutionProvider: FrameworkContextProvider<BackgroundToolExecutor> = {
  key: BackgroundToolExecutorKey,
  create(_ctx, session) {
    return { value: new BackgroundToolExecutionScope(session) };
  },
  async commit(executor, session) {
    return await requireExecutionScope(executor).commit(session);
  },
  async rollback(executor, cause) {
    await requireExecutionScope(executor).rollback(cause);
  },
  decorateStepResult(executor, result) {
    return requireExecutionScope(executor).decorate(result);
  },
};

export function stageBackgroundToolEffect(task: TaskExec, effect: BackgroundToolEffect): void {
  requireTaskRecord(task).effects.push(effect);
}

export function readBackgroundToolBatch(task: TaskExec): readonly BackgroundToolCall[] {
  return requireTaskRecord(task).batch.calls;
}

export function readBackgroundTask(task: TaskExec): BackgroundTask {
  const record = requireTaskRecord(task);
  if (record.task === undefined) {
    throw new Error("Background task identity is unavailable before execution starts.");
  }
  return record.task;
}

export function readBackgroundToolSession(task: TaskExec): HarnessSession {
  return requireTaskRecord(task).session;
}

/** Returns effects retained when cancellation raced a successfully delegated task. */
export function readRetainedBackgroundToolResult(
  ctx: ContextContainer,
): BackgroundToolStepResult | undefined {
  const executor = ctx.get(BackgroundToolExecutorKey);
  return executor instanceof BackgroundToolExecutionScope ? executor.retainedResult() : undefined;
}

class BackgroundToolExecutionScope implements BackgroundToolExecutor {
  private readonly executions = new Map<string, Promise<unknown>>();
  private readonly records: BackgroundToolExecutionRecord[] = [];
  private retained = false;

  private readonly initialSession: HarnessSession;

  constructor(initialSession: HarnessSession) {
    this.initialSession = initialSession;
  }

  execute(input: {
    readonly batch: BackgroundToolCallBatch;
    readonly definition: BackgroundExecutableTool;
    readonly options: ToolExecuteOptions;
    readonly toolInput: unknown;
  }): Promise<unknown> {
    const existing = this.executions.get(input.options.toolCallId);
    if (existing !== undefined) return existing;
    if (!input.batch.calls.some((call) => call.callId === input.options.toolCallId)) {
      throw new Error(
        `Background tool call "${input.options.toolCallId}" was not registered before execution.`,
      );
    }
    const execution = this.start(input);
    this.executions.set(input.options.toolCallId, execution);
    return execution;
  }

  async commit(session: HarnessSession): Promise<HarnessSession> {
    const incomplete = this.records.filter((record) => !record.settled);
    if (incomplete.length > 0) {
      await compensateBackgroundToolExecution(
        incomplete,
        new Error("Background tool execution did not delegate or complete its task."),
      );
    }
    return this.apply(session);
  }

  decorate(result: StepResult): StepResult {
    const fields = this.resultFields();
    return fields === undefined ? result : { ...result, ...fields };
  }

  async rollback(cause: unknown): Promise<void> {
    const settled = this.records.filter((record) => record.settled);
    const incomplete = this.records.filter((record) => !record.settled);
    if (incomplete.length > 0) {
      await compensateBackgroundToolExecution(incomplete, cause);
    }
    if (settled.length === 0) return;
    if (isTurnCancellation(cause)) {
      this.retained = true;
      return;
    }
    await compensateBackgroundToolExecution(settled, cause);
  }

  retainedResult(): BackgroundToolStepResult | undefined {
    return this.retained ? this.resultFields() : undefined;
  }

  private apply(session: HarnessSession): HarnessSession {
    let next = session;
    for (const record of this.records) {
      if (!record.settled || record.task === undefined) continue;
      for (const effect of record.effects) next = effect.apply(next);
      next = recordSessionTask(next, record.task);
    }
    return next;
  }

  private resultFields(): BackgroundToolStepResult | undefined {
    const tasks = this.records.flatMap((record) =>
      record.settled && record.task !== undefined ? [record.task] : [],
    );
    if (tasks.length === 0) return undefined;
    return {
      backgroundTaskSession: this.apply(this.initialSession),
      backgroundTasks: tasks.map(({ taskInboxToken, taskId, taskRunId }) => ({
        taskInboxToken,
        taskId,
        taskRunId,
      })),
    };
  }

  private async start(input: {
    readonly batch: BackgroundToolCallBatch;
    readonly definition: BackgroundExecutableTool;
    readonly options: ToolExecuteOptions;
    readonly toolInput: unknown;
  }): Promise<unknown> {
    const record: BackgroundToolExecutionRecord = {
      batch: input.batch,
      effects: [],
      session: this.initialSession,
      settled: false,
    };
    this.records.push(record);
    const emission = getHarnessEmissionState(this.initialSession.state);
    const task = await beginBackgroundTask({
      callId: input.options.toolCallId,
      metadata: { kind: "tool", name: input.definition.name },
      parentSessionId: this.initialSession.sessionId,
      parentStepIndex: emission.stepIndex,
      parentTurnId: activeTurnId(emission),
      session: this.initialSession,
    });
    record.task = task;

    const callbackBaseUrl = loadContext().get(CallbackBaseUrlKey);
    const binding = {
      taskId: task.taskId,
      token: task.taskInboxToken,
      ...(callbackBaseUrl === undefined
        ? {}
        : {
            url: createWorkflowCallbackUrl(
              callbackBaseUrl,
              createEveCallbackRoutePath(task.taskInboxToken),
            ),
          }),
    };
    const taskExec: TaskExec = {
      binding,
      delegated: ({ executor, receipt }) => createTaskDelegated({ binding, executor, receipt }),
    };
    taskRecords.set(taskExec, record);

    const output = input.definition.execute(input.toolInput, input.options, taskExec);
    if (isAsyncIterable(output)) {
      throw new Error("Background tools cannot return AsyncIterable output.");
    }
    const settled = await output;
    if (isAuthorizationSignal(settled)) return settled;
    if (isTaskDelegated(settled)) {
      await deliverTaskCommand(task, {
        executor: settled.executor,
        kind: "configure",
      });
      record.task = { ...task, executor: settled.executor };
      record.settled = true;
      return settled.receipt;
    }

    await deliverTaskCommand(task, { data: parseJsonValue(settled), kind: "complete" });
    record.settled = true;
    return settled;
  }
}

function requireExecutionScope(executor: BackgroundToolExecutor): BackgroundToolExecutionScope {
  if (!(executor instanceof BackgroundToolExecutionScope)) {
    throw new Error("The background tool executor is not owned by the task runtime.");
  }
  return executor;
}

function requireTaskRecord(task: TaskExec): BackgroundToolExecutionRecord {
  const record = taskRecords.get(task);
  if (record === undefined) {
    throw new Error("Background task capability is not active for this tool execution.");
  }
  return record;
}

async function deliverTaskCommand(
  task: BackgroundTask,
  command: Parameters<typeof sendTaskCommand>[0]["command"],
): Promise<void> {
  const outcome = await sendTaskCommand({ command, taskInboxToken: task.taskInboxToken });
  if (outcome !== "delivered") {
    throw new Error(`Task run "${task.taskId}" did not accept "${command.kind}".`);
  }
}

async function compensateBackgroundToolExecution(
  records: readonly BackgroundToolExecutionRecord[],
  cause: unknown,
): Promise<void> {
  const failures: unknown[] = [];
  for (const record of records.toReversed()) {
    for (const effect of record.effects.toReversed()) {
      if (effect.rollback === undefined) continue;
      try {
        await effect.rollback(cause);
      } catch (error) {
        failures.push(error);
      }
    }
    if (record.task === undefined) continue;
    try {
      await rejectDelegatedDispatch({
        error: {
          code: "PARENT_STEP_FAILED",
          message: cause instanceof Error ? cause.message : String(cause),
        },
        task: record.task,
      });
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      [cause, ...failures],
      "Background tool execution failed and its effects could not all be rolled back.",
      { cause },
    );
  }
}
