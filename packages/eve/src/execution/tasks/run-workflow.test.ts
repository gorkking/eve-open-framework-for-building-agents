import { afterEach, describe, expect, it, vi } from "vitest";
import { createHook, type Hook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook } from "#execution/hook-ownership.js";
import { appendTaskSnapshotStep, wakeTaskParentStep } from "#execution/tasks/run-steps.js";
import { taskRunWorkflow } from "#execution/tasks/run-workflow.js";
import type { TaskCommandHookPayload, TaskRunInboundPayload, TaskView } from "#tasks/types.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  createHook: vi.fn(),
}));

vi.mock("../hook-ownership.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../hook-ownership.js")>()),
  claimHookOwnership: vi.fn(),
  disposeHook: vi.fn(),
}));

vi.mock("./run-steps.js", () => ({
  appendTaskSnapshotStep: vi.fn(),
  wakeTaskParentStep: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

function createWorkingView(): TaskView {
  return {
    metadata: {
      childSessionId: "child-session-1",
      kind: "subagent",
      mode: "local",
      name: "research",
    },
    status: "working",
    taskId: "task_abc123",
  };
}

function mockCommandHook(payloads: readonly TaskRunInboundPayload[]): void {
  const queue = [...payloads];
  const hook = {
    [Symbol.asyncIterator]: () => ({
      next: async () =>
        queue.length > 0
          ? { done: false as const, value: queue.shift() as TaskCommandHookPayload }
          : { done: true as const, value: undefined },
    }),
    token: "task-token",
  } as Hook<TaskRunInboundPayload>;
  vi.mocked(createHook).mockReturnValue(hook);
}

function appendedStatuses(): readonly string[] {
  return vi.mocked(appendTaskSnapshotStep).mock.calls.map(([input]) => input.view.status);
}

describe("taskRunWorkflow", () => {
  it("publishes the initial snapshot, applies commands, and stops at terminal", async () => {
    mockCommandHook([
      {
        command: { inputRequests: [{ question: "which?" }], kind: "require-input" },
        kind: "task-command",
      },
      { command: { kind: "resume-working" }, kind: "task-command" },
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
      // Never consumed: the run stops at the terminal transition.
      { command: { kind: "cancel" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

    expect(appendedStatuses()).toEqual(["working", "input_required", "working", "completed"]);
    expect(disposeHook).toHaveBeenCalledTimes(1);
  });

  it("skips snapshots for rejected and noop commands", async () => {
    mockCommandHook([
      { command: { kind: "resume-working" }, kind: "task-command" }, // noop on working
      { command: { kind: "cancel" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

    expect(appendedStatuses()).toEqual(["working", "cancelled"]);
  });

  it("exits without touching the lifecycle when the hook claim conflicts", async () => {
    mockCommandHook([]);
    vi.mocked(claimHookOwnership).mockRejectedValue(
      Object.assign(new Error("Hook token in use"), { name: "HookConflictError" }),
    );

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

    expect(appendTaskSnapshotStep).not.toHaveBeenCalled();
    expect(disposeHook).not.toHaveBeenCalled();
  });

  it("disposes its hook when the command stream closes early", async () => {
    mockCommandHook([
      { command: { inputRequests: [], kind: "require-input" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });

    expect(appendedStatuses()).toEqual(["working", "input_required"]);
    expect(disposeHook).toHaveBeenCalledTimes(1);
  });

  it("translates a settled child turn from the wire and wakes the parent once ready", async () => {
    const ZERO = { cacheReadTokens: 0, cacheWriteTokens: 0, inputTokens: 0, outputTokens: 0 };
    mockCommandHook([
      { command: { childSessionId: "child-session-1", kind: "describe" }, kind: "task-command" },
      {
        kind: "runtime-action-result",
        results: [
          {
            outcome: {
              kind: "parked",
              result: { kind: "succeeded", output: "answer" },
              usageDelta: ZERO,
            },
            output: "answer",
          },
        ],
      },
    ]);

    await taskRunWorkflow({
      commandToken: "task-token",
      initialView: {
        ...createWorkingView(),
        metadata: { kind: "subagent", mode: "local", name: "research" },
      },
      wakeToken: "parent-session-token",
    });

    expect(appendedStatuses()).toEqual(["working", "working", "completed"]);
    expect(wakeTaskParentStep).toHaveBeenCalledTimes(1);
    expect(vi.mocked(wakeTaskParentStep).mock.calls[0]?.[0]).toMatchObject({
      token: "parent-session-token",
      view: { status: "completed", taskId: "task_abc123" },
    });
  });

  it("does not wake without a wake token and never wakes twice for one blocked child", async () => {
    mockCommandHook([
      { command: { inputRequests: [{ q: 1 }], kind: "require-input" }, kind: "task-command" },
      { command: { inputRequests: [{ q: 2 }], kind: "require-input" }, kind: "task-command" },
      { command: { data: "done", kind: "complete" }, kind: "task-command" },
    ]);

    await taskRunWorkflow({
      commandToken: "task-token",
      initialView: createWorkingView(),
      wakeToken: "parent-session-token",
    });

    // input_required wakes once; the second require-input replaces the
    // batch without leaving the ready state, and completing from ready
    // does not re-wake.
    expect(wakeTaskParentStep).toHaveBeenCalledTimes(1);

    vi.mocked(wakeTaskParentStep).mockClear();
    mockCommandHook([{ command: { data: "done", kind: "complete" }, kind: "task-command" }]);
    await taskRunWorkflow({ commandToken: "task-token", initialView: createWorkingView() });
    expect(wakeTaskParentStep).not.toHaveBeenCalled();
  });
});
