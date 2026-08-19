import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SandboxKey } from "#context/keys.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { replaceDurableSessionSnapshot } from "#execution/durable-session-store.js";
import {
  executeSubagentToolCall,
  runWithSubagentToolExecution,
  syncSubagentToolExecution,
} from "#execution/tasks/parent/subagent/tool-execution.js";
import { AGENT_HANDLES_STATE_KEY, getAgentHandleStore } from "#harness/handles/store.js";
import type { HarnessSession } from "#harness/types.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
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

const session: HarnessSession = {
  agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
  compaction: { recentWindowSize: 10, threshold: 100_000 },
  continuationToken: "parent-token",
  history: [],
  sessionId: "parent-session",
};

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
  it("starts sibling AI SDK subagent workflows concurrently", async () => {
    const release = new Map<string, () => void>();
    let releaseSandboxCapture!: () => void;
    const sandboxCapture = new Promise<{ initialized: boolean; session: null }>((resolve) => {
      releaseSandboxCapture = () => resolve({ initialized: true, session: null });
    });
    let activeEmissions = 0;
    let maxActiveEmissions = 0;
    const resultEvents = new Set<string>();
    const sandbox = {
      captureState: vi.fn(() => sandboxCapture),
      get: vi.fn(async () => null),
      stop: vi.fn(async () => undefined),
    };
    mocks.start.mockImplementation(async (_workflow, [input]) => {
      const action = input.batch.actions[0] as RuntimeSubagentCallActionRequest;
      const current = input.sessionState.snapshot.session;
      const agentId = `agent-${action.callId}`;
      const { entry, task } = createTask(action, agentId);
      const handles = getAgentHandleStore(current.state)?.handles ?? [];
      const tasks = getSessionTaskIndex(current.state);
      return {
        returnValue: new Promise((resolve) => {
          release.set(action.callId, () => {
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
                      handles: [...handles, createAddressedHandle(action, agentId)],
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
    const execution = contextStorage.run(ctx, () =>
      runWithSubagentToolExecution({
        handleEvent: async (event) => {
          activeEmissions += 1;
          maxActiveEmissions = Math.max(maxActiveEmissions, activeEmissions);
          await Promise.resolve();
          if (event.type === "action.result") resultEvents.add(event.data.result.callId);
          activeEmissions -= 1;
        },
        session,
        step: async () => {
          let currentSession = session;
          syncSubagentToolExecution({
            batchEvent: { sequence: 1, stepIndex: 2, turnId: "turn-1" },
            session: currentSession,
            updateSession: (nextSession) => {
              currentSession = nextSession;
            },
          });
          const toolOutputs = await Promise.all(
            [localAction, siblingAction, independentAction].map((action) =>
              executeSubagentToolCall({ action }),
            ),
          );
          return { next: { done: true, output: toolOutputs }, session: currentSession };
        },
      }),
    );

    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(1));
    release.get(independentAction.callId)?.();
    await vi.waitFor(() => expect(resultEvents.has(independentAction.callId)).toBe(true));
    releaseSandboxCapture();
    await vi.waitFor(() => expect(mocks.start).toHaveBeenCalledTimes(3));
    release.get(siblingAction.callId)?.();
    release.get(localAction.callId)?.();
    const outputs = await execution;

    expect(sandbox.get).toHaveBeenCalledTimes(1);
    expect(maxActiveEmissions).toBe(1);
    expect(
      Object.fromEntries(
        mocks.start.mock.calls.map(([, [input]]) => [
          input.batch.actions[0]?.callId,
          input.sessionState.snapshot.session.sandboxState?.initialized,
        ]),
      ),
    ).toEqual({
      [independentAction.callId]: undefined,
      [localAction.callId]: true,
      [siblingAction.callId]: true,
    });
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

  it("dispatches concurrent sibling calls to the same addressed agent", async () => {
    mocks.start.mockImplementation(async (_workflow, [input]) => {
      const action = input.batch.actions[0] as RuntimeSubagentCallActionRequest;
      const current = input.sessionState.snapshot.session;
      const handles = (getAgentHandleStore(current.state)?.handles ?? []).filter(
        (handle) => handle.identity.id !== action.input.agentId,
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
              output: { code: "TEST", message: "test dispatch completed" },
              subagentName: action.name,
            },
          ],
          sessionState: replaceDurableSessionSnapshot({
            session: {
              ...current,
              state: { ...current.state, [AGENT_HANDLES_STATE_KEY]: { handles } },
            },
            state: input.sessionState,
          }),
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

    const output = await contextStorage.run(ctx, () =>
      runWithSubagentToolExecution({
        handleEvent: async (event) => {
          events.push(event);
        },
        session: addressedSession,
        step: async () => {
          let currentSession = addressedSession;
          syncSubagentToolExecution({
            batchEvent: { sequence: 1, stepIndex: 2, turnId: "turn-1" },
            session: currentSession,
            updateSession: (nextSession) => {
              currentSession = nextSession;
            },
          });
          results = await Promise.allSettled(
            actions.map((action) => executeSubagentToolCall({ action })),
          );
          return { next: null, session: currentSession };
        },
      }),
    );

    expect(mocks.start).toHaveBeenCalledTimes(3);
    expect(sandbox.get).not.toHaveBeenCalled();
    expect(getAgentHandleStore(output.session.state)?.handles).toEqual([]);
    expect(
      events.flatMap((event) => (event.type === "action.result" ? [event.data.result.callId] : [])),
    ).toEqual(expect.arrayContaining(actions.map((action) => action.callId)));
    expect(
      events.flatMap((event) =>
        event.type === "actions.requested" ? event.data.actions.map((action) => action.callId) : [],
      ),
    ).toEqual(expect.arrayContaining(actions.map((action) => action.callId)));
    expect(results).toEqual(
      actions.map(() =>
        expect.objectContaining({
          reason: expect.objectContaining({
            message: expect.stringContaining("test dispatch completed"),
          }),
          status: "rejected",
        }),
      ),
    );
  });

  it("cancels and acknowledges a started task when the model step fails", async () => {
    const { entry, task } = createTask(localAction, "call-local");
    mocks.start.mockImplementation(async (_workflow, [input]) => {
      const current = input.sessionState.snapshot.session;
      return {
        returnValue: Promise.resolve({
          pendingTasks: [task],
          results: [
            {
              backgroundTask: { status: "working", taskId: task.taskId },
              callId: localAction.callId,
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
        state: { [SESSION_TASKS_STATE_KEY]: { tasks: [entry] } },
      }),
    });
    expect(mocks.acknowledgeDelegatedTasks).toHaveBeenCalledWith({ tasks: [task] });
  });
});
