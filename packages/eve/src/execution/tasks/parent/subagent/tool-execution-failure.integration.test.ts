import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { replaceDurableSessionSnapshot } from "#execution/durable-session-store.js";
import {
  executeSubagentToolCall,
  prepareSubagentToolExecutionBatch,
  runWithSubagentToolExecution,
} from "#execution/tasks/parent/subagent/tool-execution.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import type { HarnessSession } from "#harness/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { SESSION_TASKS_STATE_KEY } from "#tasks/session-index.js";

const mocks = vi.hoisted(() => ({
  cancelOwnedTask: vi.fn(),
  rejectDelegatedDispatch: vi.fn(),
  start: vi.fn(),
}));

vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/workflow/runtime.js")>()),
  start: mocks.start,
}));
vi.mock("#execution/tasks/parent/delegate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/tasks/parent/delegate.js")>()),
  rejectDelegatedDispatch: mocks.rejectDelegatedDispatch,
}));
vi.mock("#execution/tasks/parent/dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/tasks/parent/dispatch.js")>()),
  cancelOwnedTask: mocks.cancelOwnedTask,
}));

const session: HarnessSession = setHarnessEmissionState(
  {
    agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
    compaction: { recentWindowSize: 10, threshold: 100_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
  },
  { sessionStarted: true, sequence: 1, stepIndex: 2, turnId: "turn-1" },
);

const localAction: RuntimeSubagentCallActionRequest = {
  callId: "call-local",
  description: "Local worker",
  input: { message: "local" },
  kind: "subagent-call",
  name: "local-worker",
  nodeId: "local-node",
  subagentName: "local-worker",
};

function prepareBatch(): void {
  prepareSubagentToolExecutionBatch({
    executableCallIds: [localAction.callId],
    localFanoutSize: 1,
  });
}

function createTask() {
  const task = {
    taskId: `task-${localAction.callId}`,
    taskInboxToken: `inbox-${localAction.callId}`,
    taskRunId: `run-${localAction.callId}`,
  };
  return {
    entry: {
      ...task,
      createdByStepIndex: 2,
      createdByTurnId: "turn-1",
      metadata: {
        agentId: "call-local",
        kind: "subagent" as const,
        mode: "local" as const,
        name: localAction.name,
      },
      operationId: `operation-${localAction.callId}`,
    },
    task,
  };
}

function createBundle() {
  return {
    compiledArtifactsSource: { kind: "bundled" },
    graph: {
      nodesByNodeId: new Map([
        [localAction.nodeId, { sandboxRegistry: { sandbox: { definition: {} } } }],
      ]),
    },
    subagentRegistry: { subagentsByNodeId: new Map([[localAction.nodeId, {}]]) },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("subagent tool execution failures", () => {
  it("emits a terminal action result when the Workflow launch fails", async () => {
    const failure = new Error("workflow transport unavailable");
    mocks.start.mockRejectedValue(failure);
    const events: UnstampedMessageStreamEvent[] = [];
    const ctx = new ContextContainer();
    ctx.set(BundleKey, createBundle() as never);

    await expect(
      contextStorage.run(ctx, () =>
        runWithSubagentToolExecution({
          handleEvent: async (event) => {
            events.push(event);
          },
          session,
          step: async () => {
            prepareBatch();
            await executeSubagentToolCall({ action: localAction });
            return { next: null, session };
          },
        }),
      ),
    ).rejects.toBe(failure);

    expect(events).toEqual([
      expect.objectContaining({ type: "actions.requested" }),
      expect.objectContaining({
        data: expect.objectContaining({
          result: expect.objectContaining({
            callId: localAction.callId,
            isError: true,
            output: {
              code: "SUBAGENT_EXECUTION_FAILED",
              message: "Subagent dispatch failed: workflow transport unavailable",
            },
          }),
        }),
        type: "action.result",
      }),
    ]);
  });

  it("cancels and silently rejects a started task when the model step fails", async () => {
    const { entry, task } = createTask();
    mocks.start.mockImplementation(async (_workflow, [input]) => {
      const action = input.batch.actions[0] as RuntimeSubagentCallActionRequest;
      const current = input.sessionState.snapshot.session;
      return {
        returnValue: Promise.resolve({
          pendingTasks: [task],
          results: [
            {
              backgroundTask: { status: "working", taskId: task.taskId },
              callId: action.callId,
              kind: "subagent-result",
              origin: "child",
              output: { agentId: "call-local", status: "working", taskId: task.taskId },
              subagentName: localAction.name,
            },
          ],
          sessionState: replaceDurableSessionSnapshot({
            session: {
              ...current,
              sandboxState: { initialized: true, session: null },
              state: { [SESSION_TASKS_STATE_KEY]: { tasks: [entry] } },
            },
            state: input.sessionState,
          }),
        }),
        runId: "workflow-batch",
      };
    });
    const bundle = createBundle() as never;
    const ctx = new ContextContainer();
    ctx.set(BundleKey, bundle);
    const failure = new Error("model failed after tool execution");

    await expect(
      contextStorage.run(ctx, () =>
        runWithSubagentToolExecution({
          session,
          step: async () => {
            prepareBatch();
            await executeSubagentToolCall({ action: localAction });
            throw failure;
          },
        }),
      ),
    ).rejects.toBe(failure);

    expect(mocks.cancelOwnedTask).toHaveBeenCalledWith({
      bundle,
      entry,
      session: expect.objectContaining({
        sandboxState: { initialized: true, session: null },
        state: expect.objectContaining({
          [SESSION_TASKS_STATE_KEY]: { tasks: [entry] },
        }),
      }),
    });
    expect(mocks.rejectDelegatedDispatch).toHaveBeenCalledWith({
      error: { code: "PARENT_STEP_FAILED", message: failure.message },
      task,
    });
  });
});
