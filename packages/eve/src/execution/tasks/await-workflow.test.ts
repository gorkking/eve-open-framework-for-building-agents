import { afterEach, describe, expect, it, vi } from "vitest";
import { sleep } from "#compiled/@workflow/core/index.js";

import { postTaskAwaitResultStep, readAwaitedTaskViewsStep } from "#execution/tasks/await-steps.js";
import { taskAwaitWorkflow } from "#execution/tasks/await-workflow.js";
import type { TaskView } from "#tasks/types.js";

vi.mock("#compiled/@workflow/core/index.js", () => ({
  sleep: vi.fn(),
}));

vi.mock("./await-steps.js", () => ({
  postTaskAwaitResultStep: vi.fn(),
  readAwaitedTaskViewsStep: vi.fn(),
}));

afterEach(() => {
  vi.resetAllMocks();
});

function createView(taskId: string, status: TaskView["status"]): TaskView {
  return {
    metadata: { kind: "subagent", mode: "local", name: "research" },
    status,
    taskId,
  };
}

const INPUT = {
  callId: "call-await-1",
  replyToken: "turn-inbox-token",
  tasks: [
    { taskId: "task_a", taskRunId: "run-a" },
    { taskId: "task_b", taskRunId: "run-b" },
  ],
  toolName: "task_await",
};

describe("taskAwaitWorkflow", () => {
  it("polls until every task is ready, then posts one aggregated result", async () => {
    vi.mocked(readAwaitedTaskViewsStep)
      .mockResolvedValueOnce({
        kind: "views",
        views: [createView("task_a", "completed"), createView("task_b", "working")],
      })
      .mockResolvedValueOnce({
        kind: "views",
        views: [createView("task_a", "completed"), createView("task_b", "input_required")],
      });
    vi.mocked(sleep).mockResolvedValue(undefined);

    await taskAwaitWorkflow(INPUT);

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(postTaskAwaitResultStep).toHaveBeenCalledTimes(1);
    expect(vi.mocked(postTaskAwaitResultStep).mock.calls[0]?.[0]).toMatchObject({
      callId: "call-await-1",
      replyToken: "turn-inbox-token",
      toolName: "task_await",
    });
  });

  it("stops polling without posting when the waiting turn is gone", async () => {
    vi.mocked(readAwaitedTaskViewsStep).mockResolvedValue({ kind: "listener-gone" });

    await taskAwaitWorkflow(INPUT);

    expect(postTaskAwaitResultStep).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
  });
});
