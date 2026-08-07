import { describe, expect, it } from "vitest";

import type { HarnessSession } from "#harness/types.js";
import {
  SESSION_TASKS_STATE_KEY,
  findSessionTaskEntry,
  getSessionTaskIndex,
  recordSessionTask,
} from "#tasks/session-index.js";
import { deriveTaskId } from "#tasks/task-id.js";
import type { SessionTaskIndexEntry } from "#tasks/session-index.js";

function taskEntry(overrides: Partial<SessionTaskIndexEntry> = {}): SessionTaskIndexEntry {
  return {
    childSessionId: "child-1",
    commandToken: "task:token-1",
    createdByTurnId: "turn-1",
    operationId: "operation-1",
    taskId: "task_a",
    taskRunId: "run-1",
    ...overrides,
  };
}

function createSession(state?: HarnessSession["state"]): HarnessSession {
  return {
    agent: {
      modelReference: { id: "model_test" },
      system: "",
      tools: [],
    },
    compaction: { recentWindowSize: 4, threshold: 1_000_000 },
    continuationToken: "continuation_test",
    history: [],
    sessionId: "session_parent",
    state,
  };
}

describe("session task index", () => {
  it("returns an empty index when the key is absent", () => {
    expect(getSessionTaskIndex({})).toEqual([]);
    expect(getSessionTaskIndex(undefined)).toEqual([]);
  });

  it("records a task and finds it by id", () => {
    const session = recordSessionTask(createSession(), taskEntry());

    expect(findSessionTaskEntry(session.state, "task_a")).toEqual({
      childSessionId: "child-1",
      commandToken: "task:token-1",
      createdByTurnId: "turn-1",
      operationId: "operation-1",
      taskId: "task_a",
      taskRunId: "run-1",
    });
    expect(findSessionTaskEntry(session.state, "task_other")).toBeUndefined();
  });

  it("replaces the entry on replayed creation instead of duplicating it", () => {
    let session = recordSessionTask(createSession(), taskEntry());
    session = recordSessionTask(
      session,
      taskEntry({
        commandToken: "task:token-2",
        taskRunId: "run-2",
      }),
    );

    const entries = getSessionTaskIndex(session.state);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.taskRunId).toBe("run-2");
  });

  it("throws on a corrupt index instead of treating it as absent", () => {
    expect(() =>
      getSessionTaskIndex({ [SESSION_TASKS_STATE_KEY]: { tasks: [{ taskId: 42 }] } }),
    ).toThrow(`Corrupt task index under session state key "${SESSION_TASKS_STATE_KEY}"`);
  });
});

describe("deriveTaskId", () => {
  it("is deterministic for the same originating call and distinct otherwise", () => {
    const input = { callId: "call-1", parentSessionId: "session-1", parentTurnId: "turn-1" };

    expect(deriveTaskId(input)).toBe(deriveTaskId(input));
    expect(deriveTaskId(input)).toMatch(/^task_[0-9a-f]{24}$/);
    expect(deriveTaskId({ ...input, callId: "call-2" })).not.toBe(deriveTaskId(input));
  });
});
