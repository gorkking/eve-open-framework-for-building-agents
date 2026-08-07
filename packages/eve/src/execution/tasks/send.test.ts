import { beforeEach, describe, expect, it, vi } from "vitest";

import { dispatchToAgentHandle, type RuntimeSession } from "#execution/agent-handle-dispatch.js";
import {
  beginDelegatedTask,
  failDelegatedDispatch,
  settleDelegatedDispatch,
} from "#execution/tasks/delegate.js";
import { readLatestTaskSnapshot } from "#execution/tasks/run-control.js";
import { executeTaskSend } from "#execution/tasks/send.js";
import { AGENT_HANDLES_STATE_KEY } from "#harness/handles/store.js";
import type { RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { SESSION_TASKS_STATE_KEY, type SessionTaskIndexEntry } from "#tasks/session-index.js";
import type { TaskStatus, TaskView } from "#tasks/types.js";

vi.mock("#execution/agent-handle-dispatch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#execution/agent-handle-dispatch.js")>()),
  dispatchToAgentHandle: vi.fn(),
}));
vi.mock("#execution/tasks/delegate.js", () => ({
  beginDelegatedTask: vi.fn(),
  failDelegatedDispatch: vi.fn(),
  settleDelegatedDispatch: vi.fn(),
}));
vi.mock("#execution/tasks/run-control.js", () => ({
  readLatestTaskSnapshot: vi.fn(),
}));

const childSessionId = "child-session";
const metadata = {
  childSessionId,
  kind: "subagent" as const,
  mode: "local" as const,
  name: "research",
};

function entry(
  taskId: string,
  createdByTurnId: string,
  createdByStepIndex?: number,
): SessionTaskIndexEntry {
  return {
    childSessionId,
    commandToken: `token-${taskId}`,
    createdByStepIndex,
    createdByTurnId,
    operationId: `operation-${taskId}`,
    taskId,
    taskRunId: `run-${taskId}`,
  };
}

function view(taskId: string, status: TaskStatus): TaskView {
  return { metadata, status, taskId };
}

function session(tasks: readonly SessionTaskIndexEntry[]): RuntimeSession {
  return {
    agent: { modelReference: { id: "model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
    state: {
      [AGENT_HANDLES_STATE_KEY]: {
        handles: [
          {
            address: {
              continuationToken: "child-token",
              kind: "agent/local",
              sessionId: childSessionId,
            },
            identity: { id: "agent-1", name: "research", nodeId: "node-research" },
            lastStatus: "idle",
            phase: "parked",
          },
        ],
      },
      [SESSION_TASKS_STATE_KEY]: { tasks },
    },
  } as RuntimeSession;
}

const action: RuntimeToolCallActionRequest = {
  callId: "call-send",
  input: { message: "continue", taskId: "task_terminal" },
  kind: "tool-call",
  toolName: "task_send",
};

describe("task_send child-session admission", () => {
  beforeEach(() => vi.resetAllMocks());

  it.each([
    ["nonterminal task", "turn-old", "working" as const],
    ["task admitted in this batch", "turn-current", "completed" as const],
  ])("rejects a follow-up for a %s", async (_name, createdByTurnId, conflictingStatus) => {
    const current = session([
      entry("task_terminal", "turn-old"),
      entry("task_conflict", createdByTurnId),
    ]);
    vi.mocked(readLatestTaskSnapshot).mockImplementation(async ({ taskRunId }) =>
      taskRunId === "run-task_terminal"
        ? view("task_terminal", "completed")
        : view("task_conflict", conflictingStatus),
    );

    const result = await executeTaskSend({
      action,
      bundle: {} as CompiledBundle,
      parentTurnId: "turn-current",
      session: current,
    });

    expect(result.result).toMatchObject({
      isError: true,
      output: { message: expect.stringContaining("AGENT_BUSY") },
    });
    expect(beginDelegatedTask).not.toHaveBeenCalled();
    expect(dispatchToAgentHandle).not.toHaveBeenCalled();
  });

  it("allows reuse in a later batch of the same turn after terminal settlement", async () => {
    const current = session([
      entry("task_terminal", "turn-old"),
      entry("task_previous", "turn-current", 0),
    ]);
    vi.mocked(readLatestTaskSnapshot).mockResolvedValue(view("task_terminal", "completed"));
    vi.mocked(beginDelegatedTask).mockResolvedValue({
      commandToken: "task-token-new",
      createdByTurnId: "turn-current",
      operationId: "operation-new",
      taskId: "task_new",
      taskRunId: "run-new",
    });
    vi.mocked(dispatchToAgentHandle).mockResolvedValue({
      address: { continuationToken: "child-token", kind: "agent/local", sessionId: childSessionId },
      callId: action.callId,
      kind: "called",
      name: "research",
      session: current,
      toolName: "research",
    });
    vi.mocked(settleDelegatedDispatch).mockResolvedValue({
      receipt: {} as never,
      session: current,
    });

    const result = await executeTaskSend({
      action,
      bundle: {} as CompiledBundle,
      parentStepIndex: 1,
      parentTurnId: "turn-current",
      session: current,
    });

    expect(result.result).toMatchObject({ output: { status: "working", taskId: "task_new" } });
    expect(failDelegatedDispatch).not.toHaveBeenCalled();
  });

  it("reserves the child before an ambiguous continuation delivery", async () => {
    const current = session([entry("task_terminal", "turn-old")]);
    const reserved = session([
      entry("task_terminal", "turn-old"),
      entry("task_new", "turn-current"),
    ]);
    vi.mocked(readLatestTaskSnapshot).mockResolvedValue(view("task_terminal", "completed"));
    vi.mocked(beginDelegatedTask).mockResolvedValue({
      commandToken: "task-token-new",
      createdByTurnId: "turn-current",
      operationId: "operation-new",
      taskId: "task_new",
      taskRunId: "run-new",
    });
    vi.mocked(settleDelegatedDispatch).mockResolvedValue({
      receipt: {} as never,
      session: reserved,
    });
    vi.mocked(dispatchToAgentHandle).mockResolvedValue({
      kind: "error",
      result: {
        callId: action.callId,
        isError: true,
        kind: "subagent-result",
        origin: "dispatch",
        output: { code: "AGENT_UNREACHABLE", message: "response lost" },
        subagentName: "research",
      },
      session: reserved,
    });

    const result = await executeTaskSend({
      action,
      bundle: {} as CompiledBundle,
      parentTurnId: "turn-current",
      session: current,
    });

    expect(vi.mocked(settleDelegatedDispatch).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(dispatchToAgentHandle).mock.invocationCallOrder[0] ?? 0,
    );
    expect(dispatchToAgentHandle).toHaveBeenCalledWith(
      expect.objectContaining({ currentSession: reserved }),
    );
    expect(result.result).toMatchObject({
      isError: true,
      output: { taskId: "task_new" },
    });
    expect(result.session).toBe(reserved);
  });
});
