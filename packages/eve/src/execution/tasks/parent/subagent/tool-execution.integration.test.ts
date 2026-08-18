import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { BundleKey } from "#runtime/sessions/runtime-context-keys.js";
import { replaceDurableSessionSnapshot } from "#execution/durable-session-store.js";
import {
  executeSubagentToolCall,
  runWithSubagentToolExecution,
  syncSubagentToolExecution,
} from "#execution/tasks/parent/subagent/tool-execution.js";
import { subagentWorkflowReference } from "#execution/tasks/parent/subagent/workflow-reference.js";
import type { HarnessSession } from "#harness/types.js";
import type {
  RuntimeRemoteAgentCallActionRequest,
  RuntimeSubagentCallActionRequest,
} from "#runtime/actions/types.js";

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
const remoteAction: RuntimeRemoteAgentCallActionRequest = {
  callId: "call-remote",
  description: "Remote worker",
  input: { message: "remote" },
  kind: "remote-agent-call",
  name: "remote-worker",
  nodeId: "remote-node",
  remoteAgentName: "remote-worker",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("subagent tool execution controller", () => {
  it("serializes local and remote AI SDK subagent calls", async () => {
    mocks.start.mockImplementation(async (_workflow, [input]) => {
      const action = input.batch.actions[0] as { callId: string; name: string };
      const current = input.sessionState.snapshot.session;
      const dispatchedCalls = (current.state?.dispatchedCalls as string[] | undefined) ?? [];
      return {
        returnValue: Promise.resolve({
          pendingTasks: [
            {
              taskId: `task-${action.callId}`,
              taskInboxToken: `inbox-${action.callId}`,
              taskRunId: `run-${action.callId}`,
            },
          ],
          results: [
            {
              backgroundTask: { status: "working", taskId: `task-${action.callId}` },
              callId: action.callId,
              kind: "subagent-result",
              origin: "child",
              output: {
                agentId: action.callId,
                status: "working",
                taskId: `task-${action.callId}`,
              },
              subagentName: action.name,
            },
          ],
          sessionState: replaceDurableSessionSnapshot({
            session: {
              ...current,
              state: { ...current.state, dispatchedCalls: [...dispatchedCalls, action.callId] },
            },
            state: input.sessionState,
          }),
        }),
        runId: `workflow-${action.callId}`,
      };
    });

    const outputs = await contextStorage.run(new ContextContainer(), () =>
      runWithSubagentToolExecution({
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
            [localAction, remoteAction].map((action) => executeSubagentToolCall({ action })),
          );
          return { next: { done: true, output: toolOutputs }, session: currentSession };
        },
      }),
    );

    expect(mocks.start).toHaveBeenNthCalledWith(1, subagentWorkflowReference, [
      expect.objectContaining({ batch: expect.objectContaining({ actions: [localAction] }) }),
    ]);
    expect(mocks.start).toHaveBeenNthCalledWith(2, subagentWorkflowReference, [
      expect.objectContaining({ batch: expect.objectContaining({ actions: [remoteAction] }) }),
    ]);
    expect(outputs.next).toMatchObject({
      output: [
        { status: "working", taskId: "task-call-local" },
        { status: "working", taskId: "task-call-remote" },
      ],
    });
    expect(outputs.delegatedTasks).toHaveLength(2);
    expect(outputs.session.state?.dispatchedCalls).toEqual(["call-local", "call-remote"]);
  });

  it("cancels and acknowledges a started task when the model step fails", async () => {
    const task = {
      taskId: "task-call-local",
      taskInboxToken: "inbox-call-local",
      taskRunId: "run-call-local",
    };
    const entry = {
      ...task,
      createdByStepIndex: 0,
      createdByTurnId: "turn-1",
      metadata: {
        agentId: "call-local",
        kind: "subagent" as const,
        mode: "local" as const,
        name: "local-worker",
      },
      operationId: "operation-call-local",
    };
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
            session: { ...current, state: { "eve.tasks": { tasks: [entry] } } },
            state: input.sessionState,
          }),
        }),
        runId: "workflow-batch",
      };
    });
    const bundle = { compiledArtifactsSource: { kind: "bundled" } } as never;
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
      session: expect.objectContaining({ state: { "eve.tasks": { tasks: [entry] } } }),
    });
    expect(mocks.acknowledgeDelegatedTasks).toHaveBeenCalledWith({ tasks: [task] });
  });
});
