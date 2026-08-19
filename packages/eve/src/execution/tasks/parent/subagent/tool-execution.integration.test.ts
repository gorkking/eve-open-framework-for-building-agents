import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { replaceDurableSessionSnapshot } from "#execution/durable-session-store.js";
import {
  beginSubagentToolExecutionAttempt,
  executeSubagentToolCall,
  prepareSubagentToolExecutionBatch,
  runWithSubagentToolExecution,
} from "#execution/tasks/parent/subagent/tool-execution.js";
import { AGENT_HANDLES_STATE_KEY, getAgentHandleStore } from "#harness/handles/store.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import type { HarnessSession } from "#harness/types.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#runtime/actions/types.js";
import { createSubagentCalledEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";
import { getSessionTaskIndex, SESSION_TASKS_STATE_KEY } from "#tasks/session-index.js";

const mocks = vi.hoisted(() => ({
  acknowledgeDelegatedTasks: vi.fn(),
  cancelOwnedTask: vi.fn(),
  start: vi.fn(),
}));

vi.mock("#internal/workflow/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#internal/workflow/runtime.js")>()),
  start: mocks.start,
}));
vi.mock("#execution/tasks/parent/delegate.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/tasks/parent/delegate.js")>()),
  acknowledgeDelegatedTasks: mocks.acknowledgeDelegatedTasks,
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
const siblingAction: RuntimeSubagentCallActionRequest = {
  ...localAction,
  callId: "call-sibling",
  input: { message: "sibling" },
};
const independentAction: RuntimeSubagentCallActionRequest = {
  ...localAction,
  callId: "call-independent",
  input: { message: "independent" },
  nodeId: "independent-node",
};

function prepareBatch(actions: readonly SubagentAction[]): void {
  prepareSubagentToolExecutionBatch(actions.map(({ callId }) => callId));
}

type SubagentAction = RuntimeRemoteAgentCallActionRequest | RuntimeSubagentCallActionRequest;

function createTask(action: RuntimeSubagentCallActionRequest, agentId = `agent-${action.callId}`) {
  const task = {
    taskId: `task-${action.callId}`,
    taskInboxToken: `inbox-${action.callId}`,
    taskRunId: `run-${action.callId}`,
  };
  return {
    entry: {
      ...task,
      createdByStepIndex: 2,
      createdByTurnId: "turn-1",
      metadata: { agentId, kind: "subagent" as const, mode: "local" as const, name: action.name },
      operationId: `operation-${action.callId}`,
    },
    task,
  };
}

function createAddressedHandle(action: RuntimeSubagentCallActionRequest, agentId: string) {
  return {
    address: {
      continuationToken: `child-token-${action.callId}`,
      kind: "agent/local" as const,
      sessionId: `child-${action.callId}`,
    },
    identity: { id: agentId, name: action.name, nodeId: action.nodeId },
    phase: "addressed" as const,
  };
}

function createBundle(inheritsParent = false) {
  return {
    compiledArtifactsSource: { kind: "bundled" },
    graph: {
      nodesByNodeId: new Map([
        [localAction.nodeId, { sandboxRegistry: { sandbox: { definition: { inheritsParent } } } }],
        [
          independentAction.nodeId,
          { sandboxRegistry: { sandbox: { definition: { inheritsParent: false } } } },
        ],
      ]),
    },
    subagentRegistry: {
      subagentsByNodeId: new Map([
        [localAction.nodeId, {}],
        [independentAction.nodeId, {}],
      ]),
    },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("subagent tool execution controller", () => {
  it("settles started tasks instead of retrying the model after a subagent dispatch", async () => {
    const { entry, task } = createTask(localAction, "call-local");
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
              output: { status: "working", taskId: task.taskId },
              subagentName: action.name,
            },
          ],
          sessionState: replaceDurableSessionSnapshot({
            session: {
              ...current,
              state: { [SESSION_TASKS_STATE_KEY]: { tasks: [entry] } },
            },
            state: input.sessionState,
          }),
        }),
        runId: `workflow-${action.callId}`,
      };
    });
    const bundle = createBundle() as never;
    const ctx = new ContextContainer();
    ctx.set(BundleKey, bundle);

    await expect(
      contextStorage.run(ctx, () =>
        runWithSubagentToolExecution({
          session,
          step: async () => {
            beginSubagentToolExecutionAttempt();
            prepareBatch([localAction]);
            await executeSubagentToolCall({ action: localAction });
            beginSubagentToolExecutionAttempt();
            throw new Error("unreachable");
          },
        }),
      ),
    ).rejects.toThrow("cannot be retried after a subagent tool has started durable work");

    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.cancelOwnedTask).toHaveBeenCalledWith({
      bundle,
      entry,
      session: expect.objectContaining({
        state: expect.objectContaining({
          [SESSION_TASKS_STATE_KEY]: { tasks: [entry] },
        }),
      }),
    });
    expect(mocks.acknowledgeDelegatedTasks).toHaveBeenCalledWith({ tasks: [task] });
  });

  it("rebuilds a remote child stream path with the provider-visible call ID", async () => {
    const action: RuntimeRemoteAgentCallActionRequest = {
      callId: "provider-call",
      description: "Remote research agent",
      input: { message: "research" },
      kind: "remote-agent-call",
      name: "research",
      nodeId: "remote-node",
      remoteAgentName: "research",
    };
    const task = {
      taskId: "task-provider-call",
      taskInboxToken: "inbox-provider-call",
      taskRunId: "run-provider-call",
    };
    const entry = {
      ...task,
      createdByStepIndex: 2,
      createdByTurnId: "turn-1",
      metadata: {
        agentId: "remote-agent",
        kind: "subagent" as const,
        mode: "remote" as const,
        name: action.name,
      },
      operationId: "operation-provider-call",
    };
    mocks.start.mockImplementation(async (_workflow, [input]) => {
      const dispatchAction = input.batch.actions[0] as RuntimeRemoteAgentCallActionRequest;
      const current = input.sessionState.snapshot.session;
      return {
        returnValue: Promise.resolve({
          calledEvents: [
            createSubagentCalledEvent({
              callId: dispatchAction.callId,
              childSessionId: "remote-child",
              name: "research",
              remote: { resolverId: "subagents/research", url: "https://remote.example" },
              sequence: 1,
              sessionId: session.sessionId,
              toolName: "research",
              turnId: "turn-1",
              workflowId: "remote-workflow",
            }),
          ],
          pendingTasks: [task],
          results: [
            {
              backgroundTask: { status: "working", taskId: task.taskId },
              callId: dispatchAction.callId,
              kind: "subagent-result",
              origin: "child",
              output: { agentId: "remote-agent", status: "working", taskId: task.taskId },
              subagentName: action.name,
            },
          ],
          sessionState: replaceDurableSessionSnapshot({
            session: {
              ...current,
              state: { [SESSION_TASKS_STATE_KEY]: { tasks: [entry] } },
            },
            state: input.sessionState,
          }),
        }),
        runId: "remote-workflow",
      };
    });
    const unrelatedToolSandboxState = {
      initialized: true,
      session: { backendName: "test", metadata: {}, sessionKey: "unrelated-tool" },
    } as const;
    const sandbox = {
      captureState: vi.fn(async () => unrelatedToolSandboxState),
      get: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
    };
    const events: UnstampedMessageStreamEvent[] = [];
    const ctx = new ContextContainer();
    ctx.set(BundleKey, createBundle() as never);
    ctx.set(SandboxKey, sandbox);

    const output = await contextStorage.run(ctx, () =>
      runWithSubagentToolExecution({
        handleEvent: async (event) => {
          events.push(event);
        },
        session,
        step: async () => {
          prepareBatch([action]);
          await executeSubagentToolCall({ action });
          return {
            next: null,
            session: { ...session, sandboxState: unrelatedToolSandboxState },
          };
        },
      }),
    );

    expect(output.delegatedTaskSandboxState).toBeUndefined();
    expect(output.session.sandboxState).toEqual(unrelatedToolSandboxState);
    expect(sandbox.get).not.toHaveBeenCalled();
    const called = events.find((event) => event.type === "subagent.called");
    expect(called).toMatchObject({
      data: {
        callId: action.callId,
        childStreamPath:
          "/eve/v1/session/parent-session/subagents/provider-call/remote-child/stream",
      },
      type: "subagent.called",
    });
  });

  it("keeps semantic dispatch ownership stable when retry siblings reorder", async () => {
    const dispatchCallIds: string[] = [];
    mocks.start.mockImplementation(async (_workflow, [input]) => {
      const action = input.batch.actions[0] as RuntimeSubagentCallActionRequest;
      dispatchCallIds.push(action.callId);
      return {
        returnValue: Promise.resolve({
          pendingTasks: [],
          results: [
            {
              callId: action.callId,
              kind: "subagent-result",
              origin: "child",
              output: "accepted",
              subagentName: action.name,
            },
          ],
          sessionState: input.sessionState,
        }),
        runId: `workflow-${action.callId}`,
      };
    });
    const outwardCallIds: string[] = [];
    const ctx = new ContextContainer();
    ctx.set(BundleKey, createBundle() as never);

    const runAttempt = async (
      siblings: readonly RuntimeSubagentCallActionRequest[],
      later: RuntimeSubagentCallActionRequest,
    ) =>
      contextStorage.run(ctx, () =>
        runWithSubagentToolExecution({
          handleEvent: async (event) => {
            if (event.type === "action.result") outwardCallIds.push(event.data.result.callId);
          },
          session,
          step: async () => {
            prepareBatch([...siblings, later]);
            await Promise.all(
              [...siblings, later].map((action) => executeSubagentToolCall({ action })),
            );
            return { next: null, session };
          },
        }),
      );

    await runAttempt([localAction, siblingAction], { ...localAction, callId: "call-local-later" });
    const firstAttemptIds = dispatchCallIds.slice();
    await runAttempt(
      [
        { ...siblingAction, callId: "call-sibling-from-retry" },
        { ...localAction, callId: "call-from-retry" },
      ],
      { ...localAction, callId: "call-local-later-from-retry" },
    );

    expect(new Set(firstAttemptIds)).toHaveProperty("size", 3);
    expect(dispatchCallIds.slice(3)).toEqual([
      firstAttemptIds[1],
      firstAttemptIds[0],
      firstAttemptIds[2],
    ]);
    expect(outwardCallIds).toEqual([
      localAction.callId,
      siblingAction.callId,
      "call-local-later",
      "call-sibling-from-retry",
      "call-from-retry",
      "call-local-later-from-retry",
    ]);
  });

  it("emits one request batch before starting sibling AI SDK subagent workflows", async () => {
    const release = new Map<string, () => void>();
    const requestEmission = Promise.withResolvers<void>();
    const requestEvents: Extract<UnstampedMessageStreamEvent, { type: "actions.requested" }>[] = [];
    let releaseSandboxCapture!: () => void;
    const sandboxCapture = new Promise<{ initialized: boolean; session: null }>((resolve) => {
      releaseSandboxCapture = () => resolve({ initialized: true, session: null });
    });
    let activeEmissions = 0;
    let maxActiveEmissions = 0;
    const resultEvents: string[] = [];
    const sandbox = {
      captureState: vi.fn(() => sandboxCapture),
      get: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
    };
    mocks.start.mockImplementation(async (_workflow, [input]) => {
      const action = input.batch.actions[0] as RuntimeSubagentCallActionRequest;
      const outwardAction = [localAction, siblingAction, independentAction].find(
        (candidate) => candidate.input.message === action.input.message,
      );
      if (outwardAction === undefined) throw new Error("Unexpected test action.");
      const current = input.sessionState.snapshot.session;
      const agentId = `agent-${outwardAction.callId}`;
      const { entry, task } = createTask(outwardAction, agentId);
      const handles = getAgentHandleStore(current.state)?.handles ?? [];
      const tasks = getSessionTaskIndex(current.state);
      return {
        returnValue: new Promise((resolve) => {
          release.set(outwardAction.callId, () => {
            resolve({
              pendingTasks: [task],
              results: [
                {
                  backgroundTask: { status: "working", taskId: task.taskId },
                  callId: action.callId,
                  kind: "subagent-result",
                  origin: "child",
                  output: { agentId, status: "working", taskId: task.taskId },
                  subagentName: action.name,
                },
              ],
              sessionState: replaceDurableSessionSnapshot({
                session: {
                  ...current,
                  state: {
                    ...current.state,
                    [AGENT_HANDLES_STATE_KEY]: {
                      handles: [...handles, createAddressedHandle(outwardAction, agentId)],
                    },
                    [SESSION_TASKS_STATE_KEY]: { tasks: [...tasks, entry] },
                  },
                },
                state: input.sessionState,
              }),
            });
          });
        }),
        runId: `workflow-${action.callId}`,
      };
    });

    const ctx = new ContextContainer();
    ctx.set(BundleKey, createBundle(true) as never);
    ctx.set(SandboxKey, sandbox);
    let currentSession = session;
    const execution = contextStorage.run(ctx, () =>
      runWithSubagentToolExecution({
        handleEvent: async (event) => {
          activeEmissions += 1;
          maxActiveEmissions = Math.max(maxActiveEmissions, activeEmissions);
          if (event.type === "actions.requested") {
            requestEvents.push(event);
            await requestEmission.promise;
          }
          if (event.type === "action.result") resultEvents.push(event.data.result.callId);
          activeEmissions -= 1;
        },
        session,
        step: async () => {
          prepareBatch([localAction, siblingAction, independentAction]);
          const localOutput = executeSubagentToolCall({ action: localAction });
          await new Promise((resolve) => setTimeout(resolve, 0));
          const siblingOutput = executeSubagentToolCall({ action: siblingAction });
          await Promise.resolve();
          const independentOutput = executeSubagentToolCall({ action: independentAction });
          const toolOutputs = await Promise.all([localOutput, siblingOutput, independentOutput]);
          return { next: { done: true, output: toolOutputs }, session: currentSession };
        },
      }),
    );

    await vi.waitFor(() => expect(requestEvents).toHaveLength(1));
    expect(mocks.start).not.toHaveBeenCalled();
    expect(requestEvents[0]?.data.actions.map((action) => action.callId)).toEqual([
      localAction.callId,
      siblingAction.callId,
      independentAction.callId,
    ]);
    requestEmission.resolve();
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    release.get(independentAction.callId)?.();
    await Promise.resolve();
    expect(resultEvents).toEqual([]);
    releaseSandboxCapture();
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(3));
    release.get(siblingAction.callId)?.();
    release.get(localAction.callId)?.();
    const outputs = await execution;

    expect(requestEvents).toHaveLength(1);
    expect(sandbox.get).toHaveBeenCalledTimes(1);
    expect(outputs.delegatedTaskSandboxState).toEqual({ initialized: true, session: null });
    expect(maxActiveEmissions).toBe(1);
    expect(resultEvents).toEqual([
      localAction.callId,
      siblingAction.callId,
      independentAction.callId,
    ]);
    expect(
      Object.fromEntries(
        mocks.start.mock.calls.map(([, [input]]) => [
          input.batch.actions[0]?.input.message,
          input.sessionState.snapshot.session.sandboxState?.initialized,
        ]),
      ),
    ).toEqual({
      independent: undefined,
      local: true,
      sibling: true,
    });
    expect(mocks.start.mock.calls.map(([, [input]]) => input.localFanoutSize)).toEqual([3, 3, 3]);
    expect(outputs.next).toMatchObject({
      output: [
        { status: "working", taskId: "task-call-local" },
        { status: "working", taskId: "task-call-sibling" },
        { status: "working", taskId: "task-call-independent" },
      ],
    });
    expect(outputs.delegatedTasks).toHaveLength(3);
    expect(getSessionTaskIndex(outputs.session.state).map((entry) => entry.taskId)).toEqual(
      expect.arrayContaining(["task-call-local", "task-call-sibling", "task-call-independent"]),
    );
    expect(
      getAgentHandleStore(outputs.session.state)?.handles.map((handle) => handle.identity.id),
    ).toEqual(
      expect.arrayContaining(["agent-call-local", "agent-call-sibling", "agent-call-independent"]),
    );
  });

  it("keeps different agents concurrent and admits same-agent continuations in order", async () => {
    const releaseFirst = Promise.withResolvers<void>();
    mocks.start.mockImplementation(async (_workflow, [input]) => {
      const action = input.batch.actions[0] as RuntimeSubagentCallActionRequest;
      const current = input.sessionState.snapshot.session;
      if (action.input.message === "first") {
        const { entry, task } = createTask(localAction, "agent-a");
        return {
          returnValue: releaseFirst.promise.then(() => ({
            pendingTasks: [task],
            results: [
              {
                backgroundTask: { status: "working", taskId: task.taskId },
                callId: action.callId,
                kind: "subagent-result",
                origin: "child",
                output: { agentId: "agent-a", status: "working", taskId: task.taskId },
                subagentName: action.name,
              },
            ],
            sessionState: replaceDurableSessionSnapshot({
              session: {
                ...current,
                state: {
                  ...current.state,
                  [SESSION_TASKS_STATE_KEY]: {
                    tasks: [...getSessionTaskIndex(current.state), entry],
                  },
                },
              },
              state: input.sessionState,
            }),
          })),
          runId: `workflow-${action.callId}`,
        };
      }

      const activeTask = getSessionTaskIndex(current.state).find(
        (entry) => entry.metadata.agentId === action.input.agentId,
      );
      return {
        returnValue: Promise.resolve({
          pendingTasks: [],
          results: [
            {
              callId: action.callId,
              isError: true,
              kind: "subagent-result",
              origin: "dispatch",
              output:
                activeTask === undefined
                  ? { code: "TEST", message: "test dispatch completed" }
                  : {
                      code: "AGENT_BUSY",
                      message: `Agent is busy with task "${activeTask.taskId}".`,
                    },
              subagentName: action.name,
            },
          ],
          sessionState: input.sessionState,
        }),
        runId: `workflow-${action.callId}`,
      };
    });
    const addressedSession: HarnessSession = {
      ...session,
      state: {
        [AGENT_HANDLES_STATE_KEY]: {
          handles: [
            createAddressedHandle(localAction, "agent-a"),
            createAddressedHandle(localAction, "agent-b"),
          ],
        },
      },
    };
    const actions = [
      { ...localAction, input: { agentId: "agent-a", message: "first" } },
      {
        ...localAction,
        callId: "call-local-sibling",
        input: { agentId: "agent-b", message: "second" },
      },
      {
        ...localAction,
        callId: "call-local-duplicate",
        input: { agentId: "agent-a", message: "duplicate" },
      },
    ];
    let results: PromiseSettledResult<unknown>[] = [];
    const events: UnstampedMessageStreamEvent[] = [];
    const sandbox = {
      captureState: vi.fn(async () => ({ initialized: true, session: null })),
      get: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
    };
    const ctx = new ContextContainer();
    ctx.set(BundleKey, createBundle(true) as never);
    ctx.set(SandboxKey, sandbox);

    const execution = contextStorage.run(ctx, () =>
      runWithSubagentToolExecution({
        handleEvent: async (event) => {
          events.push(event);
        },
        session: addressedSession,
        step: async () => {
          prepareBatch(actions);
          results = await Promise.allSettled(
            actions.map((action) => executeSubagentToolCall({ action })),
          );
          return { next: null, session: addressedSession };
        },
      }),
    );

    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(2));
    expect(
      mocks.start.mock.calls.map(([, [input]]) => input.batch.actions[0]?.input.message),
    ).toEqual(expect.arrayContaining(["first", "second"]));
    expect(
      mocks.start.mock.calls.map(([, [input]]) => input.batch.actions[0]?.input.message),
    ).not.toContain("duplicate");
    releaseFirst.resolve();
    const output = await execution;

    expect(mocks.start).toHaveBeenCalledTimes(3);
    expect(sandbox.get).not.toHaveBeenCalled();
    expect(getSessionTaskIndex(output.session.state).map((entry) => entry.taskId)).toContain(
      "task-call-local",
    );
    const duplicateInput = mocks.start.mock.calls.find(
      ([, [input]]) => input.batch.actions[0]?.input.message === "duplicate",
    )?.[1][0];
    expect(duplicateInput?.requireExistingAgent).toBe(true);
    expect(
      duplicateInput === undefined
        ? []
        : getSessionTaskIndex(duplicateInput.sessionState.snapshot.session.state).map(
            (entry) => entry.taskId,
          ),
    ).toContain("task-call-local");
    expect(
      events.flatMap((event) => (event.type === "action.result" ? [event.data.result.callId] : [])),
    ).toEqual(expect.arrayContaining(actions.map((action) => action.callId)));
    expect(
      events.flatMap((event) =>
        event.type === "actions.requested" ? event.data.actions.map((action) => action.callId) : [],
      ),
    ).toEqual(expect.arrayContaining(actions.map((action) => action.callId)));
    expect(results).toEqual([
      expect.objectContaining({
        status: "fulfilled",
        value: expect.objectContaining({ status: "working", taskId: "task-call-local" }),
      }),
      expect.objectContaining({
        reason: expect.objectContaining({
          message: expect.stringContaining("test dispatch completed"),
        }),
        status: "rejected",
      }),
      expect.objectContaining({
        reason: expect.objectContaining({
          message: expect.stringContaining("task-call-local"),
        }),
        status: "rejected",
      }),
    ]);
  });

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
            prepareBatch([localAction]);
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

  it("cancels and acknowledges a started task when the model step fails", async () => {
    const { entry, task } = createTask(localAction, "call-local");
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
    const bundle = {
      ...createBundle(),
      compiledArtifactsSource: { kind: "bundled" },
    } as never;
    const ctx = new ContextContainer();
    ctx.set(BundleKey, bundle);
    const failure = new Error("model failed after tool execution");

    await expect(
      contextStorage.run(ctx, () =>
        runWithSubagentToolExecution({
          session,
          step: async () => {
            prepareBatch([localAction]);
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
    expect(mocks.acknowledgeDelegatedTasks).toHaveBeenCalledWith({ tasks: [task] });
  });
});
