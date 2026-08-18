import { describe, expect, it } from "vitest";

import { getRun } from "#internal/workflow/runtime.js";

import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import { executeTaskControlAction } from "#execution/tasks/parent/dispatch.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import { dispatchToolTask } from "#execution/tasks/parent/tool/dispatch.js";
import { spikeToolTask } from "#execution/tasks/parent/tool/spike-tool-definition.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";
import { TASK_JOIN_TOOL_NAME } from "#runtime/framework-tools/tasks.js";
import { getSessionTaskIndex } from "#tasks/session-index.js";
import { isTerminalTaskStatus, type TaskView } from "#tasks/types.js";

const STUB_BUNDLE = {
  subagentRegistry: { subagentsByNodeId: new Map() },
} as never as CompiledBundle;

describe("plain workflow-backed tool as a task", () => {
  it("dispatches the tool's workflow as a task, reaches completed, and joins", async () => {
    const runtime = createTestRuntime({ agent: { name: "tool-task" } });

    await runtime.run(async () => {
      const session = {
        agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "http:tool-task",
        history: [],
        sessionId: "parent-tool-task",
      } as never as RuntimeSession;

      const dispatched = await dispatchToolTask({
        callId: "call-tool-task",
        parentSessionId: "parent-tool-task",
        parentTurnId: "turn-tool-task",
        session,
        toolExecute: spikeToolTask.execute,
        toolInput: { background: true, echo: "hello" },
        toolName: "spike_tool_task",
      });

      try {
        // The receipt settles the originating tool call's key immediately.
        expect(dispatched.receipt).toEqual({
          callId: "call-tool-task",
          kind: "tool-result",
          output: { status: "working", taskId: dispatched.taskId },
          toolName: "spike_tool_task",
        });
        // The session index records a tool-kind task discoverable by
        // task_peek/task_join.
        expect(getSessionTaskIndex(dispatched.session.state)).toEqual([
          expect.objectContaining({
            metadata: expect.objectContaining({ kind: "tool", name: "spike_tool_task" }),
            taskId: dispatched.taskId,
            taskRunId: dispatched.taskRunId,
          }),
        ]);
        // Three distinct runs: executor, tool workflow (inside), task run.
        expect(dispatched.executorRunId).not.toBe(dispatched.taskRunId);

        // The executor runs the tool's workflow and settles the task run.
        let view: TaskView | undefined;
        const deadline = Date.now() + 45_000;
        while (Date.now() < deadline) {
          view = await readLatestTaskView({ taskRunId: dispatched.taskRunId });
          if (view !== undefined && isTerminalTaskStatus(view.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        expect(view).toMatchObject({
          lastOutput: { data: { echoed: "spike-tool:hello" }, type: "result" },
          metadata: { kind: "tool", mode: "local", name: "spike_tool_task" },
          status: "completed",
          taskId: dispatched.taskId,
        });

        // task_join on the terminal tool task settles immediately with the
        // tool's output in the view.
        const join = await executeTaskControlAction({
          action: {
            callId: "call-join-tool",
            input: { taskId: dispatched.taskId },
            kind: "tool-call",
            toolName: TASK_JOIN_TOOL_NAME,
          },
          bundle: STUB_BUNDLE,
          parentTurnId: "turn-tool-task-join",
          session: dispatched.session,
        });
        expect(join.pendingJoin).toBeUndefined();
        expect(join.result).toMatchObject({
          callId: "call-join-tool",
          output: {
            tasks: [
              {
                lastOutput: { data: { echoed: "spike-tool:hello" }, type: "result" },
                status: "completed",
                taskId: dispatched.taskId,
              },
            ],
          },
        });
      } finally {
        await getRun(dispatched.executorRunId)
          .cancel()
          .catch(() => {});
        await getRun(dispatched.taskRunId)
          .cancel()
          .catch(() => {});
      }
    });
  }, 60_000);
});
