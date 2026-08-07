import { beforeEach, describe, expect, it, vi } from "vitest";

import { settleDelegatedDispatch, type DelegatedTask } from "#execution/tasks/delegate.js";
import { sendTaskCommandToOwner } from "#execution/tasks/run-control.js";
import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";

vi.mock("#execution/tasks/run-control.js", () => ({
  sendTaskCommandToOwner: vi.fn(),
}));

function createSession(): RuntimeSession {
  return {
    agent: { modelReference: { id: "model" }, system: "", tools: [] },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "parent-token",
    history: [],
    sessionId: "parent-session",
  } as RuntimeSession;
}

describe("delegated task settlement", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(sendTaskCommandToOwner).mockResolvedValue({ runId: "run-owner" });
  });

  it("indexes the command-hook owner rather than a replay-losing candidate run", async () => {
    const task: DelegatedTask = {
      commandToken: "task-token",
      createdByTurnId: "turn-parent",
      operationId: "operation-1",
      taskId: "task-1",
      taskRunId: "run-candidate",
    };

    const result = await settleDelegatedDispatch({
      callId: "call-task",
      childSessionId: "child-session",
      session: createSession(),
      subagentName: "research",
      task,
    });

    expect(sendTaskCommandToOwner).toHaveBeenCalledWith(
      expect.objectContaining({ command: { childSessionId: "child-session", kind: "describe" } }),
    );
    expect(getSessionTaskIndex(result.session.state)[0]).toMatchObject({
      taskId: "task-1",
      taskRunId: "run-owner",
    });
  });
});
