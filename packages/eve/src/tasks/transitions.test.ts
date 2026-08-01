import { describe, expect, it } from "vitest";

import { applyTaskTransition } from "#tasks/transitions.js";
import type { TaskCommand, TaskStatus, TaskView } from "#tasks/types.js";

function createView(status: TaskStatus, overrides: Partial<TaskView> = {}): TaskView {
  return {
    metadata: {
      childSessionId: "child-session-1",
      kind: "subagent",
      mode: "local",
      name: "research",
    },
    status,
    taskId: "task_abc123",
    ...overrides,
  };
}

const TERMINAL_STATUSES: readonly TaskStatus[] = ["completed", "failed", "cancelled"];
const ALL_COMMANDS: readonly TaskCommand[] = [
  { data: { answer: 42 }, kind: "complete" },
  { data: { message: "boom" }, kind: "fail" },
  { kind: "cancel" },
  { inputRequests: [{ question: "which?" }], kind: "require-input" },
  { kind: "resume-working" },
  { childSessionId: "child-session-2", kind: "describe" },
];

describe("applyTaskTransition", () => {
  it("completes a working task with a result output", () => {
    const result = applyTaskTransition(createView("working"), {
      data: { answer: 42 },
      kind: "complete",
    });

    expect(result.outcome).toBe("accepted");
    expect(result.view.status).toBe("completed");
    expect(result.view.lastOutput).toEqual({ data: { answer: 42 }, type: "result" });
  });

  it("fails a working task and carries the error as its output", () => {
    const result = applyTaskTransition(createView("working"), {
      data: { message: "boom" },
      kind: "fail",
    });

    expect(result.outcome).toBe("accepted");
    expect(result.view.status).toBe("failed");
    expect(result.view.lastOutput).toEqual({ data: { message: "boom" }, type: "error" });
  });

  it("moves working to input_required carrying the outstanding batch", () => {
    const result = applyTaskTransition(createView("working"), {
      inputRequests: [{ question: "which region?" }],
      kind: "require-input",
    });

    expect(result.outcome).toBe("accepted");
    expect(result.view.status).toBe("input_required");
    expect(result.view.inputRequests).toEqual([{ question: "which region?" }]);
  });

  it("returns input_required to working and clears the batch", () => {
    const blocked = applyTaskTransition(createView("working"), {
      inputRequests: [{ question: "which region?" }],
      kind: "require-input",
    });
    expect(blocked.outcome).toBe("accepted");

    const result = applyTaskTransition(blocked.view, { kind: "resume-working" });

    expect(result.outcome).toBe("accepted");
    expect(result.view.status).toBe("working");
    expect(result.view.inputRequests).toBeUndefined();
  });

  it("replaces the outstanding batch on repeated require-input", () => {
    const first = applyTaskTransition(createView("working"), {
      inputRequests: [{ question: "first" }],
      kind: "require-input",
    });
    expect(first.outcome).toBe("accepted");

    const second = applyTaskTransition(first.view, {
      inputRequests: [{ question: "second" }],
      kind: "require-input",
    });

    expect(second.outcome).toBe("accepted");
    expect(second.view.inputRequests).toEqual([{ question: "second" }]);
  });

  it("completes and cancels an input_required task", () => {
    const blocked = applyTaskTransition(createView("working"), {
      inputRequests: [{ question: "which?" }],
      kind: "require-input",
    });
    expect(blocked.outcome).toBe("accepted");

    const completed = applyTaskTransition(blocked.view, { data: "done", kind: "complete" });
    expect(completed.outcome).toBe("accepted");
    expect(completed.view.status).toBe("completed");

    const cancelled = applyTaskTransition(blocked.view, { kind: "cancel" });
    expect(cancelled.outcome).toBe("accepted");
    expect(cancelled.view.status).toBe("cancelled");
  });

  it("treats resume-working on a working task as a noop", () => {
    const result = applyTaskTransition(createView("working"), { kind: "resume-working" });

    expect(result.outcome).toBe("noop");
    expect(result.view.status).toBe("working");
  });

  it("rejects a late completion after cancellation", () => {
    const cancelled = applyTaskTransition(createView("working"), { kind: "cancel" });
    expect(cancelled.outcome).toBe("accepted");

    const late = applyTaskTransition(cancelled.view, { data: "too late", kind: "complete" });

    expect(late.outcome).toBe("rejected");
    expect(late.view.status).toBe("cancelled");
    expect(late.view.lastOutput).toBeUndefined();
  });

  it("treats repeated cancellation as an idempotent noop", () => {
    const cancelled = applyTaskTransition(createView("working"), { kind: "cancel" });
    expect(cancelled.outcome).toBe("accepted");

    const again = applyTaskTransition(cancelled.view, { kind: "cancel" });

    expect(again.outcome).toBe("noop");
    expect(again.view.status).toBe("cancelled");
  });

  it.each(TERMINAL_STATUSES)("keeps %s final against every non-cancel command", (status) => {
    const view = createView(status);
    for (const command of ALL_COMMANDS) {
      if (command.kind === "cancel" && status === "cancelled") continue;
      const result = applyTaskTransition(view, command);
      expect(result.outcome).toBe("rejected");
      expect(result.view).toBe(view);
    }
  });

  it("rejects cancel on completed and failed tasks", () => {
    for (const status of ["completed", "failed"] as const) {
      const result = applyTaskTransition(createView(status), { kind: "cancel" });
      expect(result.outcome).toBe("rejected");
    }
  });

  it("attaches the child session through describe without changing status", () => {
    const described = applyTaskTransition(
      createView("working", {
        metadata: { kind: "subagent", mode: "local", name: "research" },
      }),
      { childSessionId: "child-session-9", kind: "describe" },
    );

    expect(described.outcome).toBe("accepted");
    expect(described.view.status).toBe("working");
    expect(described.view.metadata.childSessionId).toBe("child-session-9");

    const again = applyTaskTransition(described.view, {
      childSessionId: "child-session-9",
      kind: "describe",
    });
    expect(again.outcome).toBe("noop");
  });

  it("is deterministic for replayed commands", () => {
    const view = createView("working");
    const command: TaskCommand = { data: { answer: 1 }, kind: "complete" };

    const first = applyTaskTransition(view, command);
    const second = applyTaskTransition(view, command);

    expect(first).toEqual(second);
  });
});
