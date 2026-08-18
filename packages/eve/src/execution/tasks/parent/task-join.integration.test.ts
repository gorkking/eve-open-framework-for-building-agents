import { describe, expect, it } from "vitest";

import { getRun } from "#internal/workflow/runtime.js";

import { createDurableSessionState } from "#execution/durable-session-store.js";
import type { RuntimeSession } from "#execution/agent-handle-dispatch.js";
import {
  executeTaskControlAction,
  type PendingTaskJoin,
} from "#execution/tasks/parent/dispatch.js";
import { pollJoinedTasksStep } from "#execution/tasks/parent/join-poll-step.js";
import { dispatchLocalSubagentWorkflow } from "#execution/tasks/parent/subagent/dispatch.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { setPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { HarnessSession } from "#harness/types.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import type { RuntimeToolCallActionRequest } from "#runtime/actions/types.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { TASK_JOIN_TOOL_NAME } from "#runtime/framework-tools/tasks.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import type { CompiledBundle } from "#runtime/sessions/runtime-context-keys.js";

const STUB_BUNDLE = {
  subagentRegistry: { subagentsByNodeId: new Map() },
} as never as CompiledBundle;

describe("task_join over a real background task", () => {
  it("leaves a working join pending, settles it from the poll step, then settles immediately once terminal", async () => {
    const runtime = createTestRuntime({ agent: { name: "task-join" } });

    await runtime.run(async () => {
      const action = {
        callId: "call-join-child",
        description: "General-purpose agent",
        input: { background: true, message: "Reply with exactly `join-child-ok`." },
        kind: "subagent-call" as const,
        name: "agent",
        nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
        subagentName: "agent",
      };
      const session: HarnessSession = setPendingRuntimeActionBatch({
        actions: [action],
        event: { sequence: 1, stepIndex: 0, turnId: "turn-join" },
        responseMessages: [],
        session: {
          agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
          compaction: { recentWindowSize: 10, threshold: 100_000 },
          continuationToken: "http:task-join",
          history: [],
          sessionId: "parent-task-join",
        },
      });
      const parentWritable = new WritableStream<Uint8Array>({ write() {} });

      const dispatched = await dispatchLocalSubagentWorkflow({
        entry: {
          kind: "start",
          target: { action, kind: "local", source: { type: "runtime" } },
        },
        fanoutSize: 1,
        runtimeInput: {
          parentContinuationToken: "turn-inbox-task-join",
          parentWritable,
          serializedContext: {
            "eve.auth": null,
            "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
            "eve.channel": { kind: "http", state: {} },
            "eve.continuationToken": session.continuationToken,
            "eve.mode": "conversation",
          },
          sessionState: createDurableSessionState({ session }),
        },
      });
      const pendingTask = dispatched.result.pendingTasks[0];
      const handle = getAgentHandleStore(dispatched.result.sessionState.snapshot?.session.state)
        ?.handles[0];
      if (pendingTask === undefined) throw new Error("Dispatch returned no pending task.");
      if (handle === undefined || handle.phase !== "addressed") {
        throw new Error("Dispatch returned no addressed child handle.");
      }

      const taskSession = dispatched.result.sessionState.snapshot?.session as
        | RuntimeSession
        | undefined;
      if (taskSession === undefined) throw new Error("Dispatch returned no session snapshot.");
      const joinAction: RuntimeToolCallActionRequest = {
        callId: "call-join-1",
        input: { taskId: pendingTask.taskId },
        kind: "tool-call",
        toolName: TASK_JOIN_TOOL_NAME,
      };

      try {
        // Join right after dispatch. The child usually has not settled yet
        // (pendingJoin path); a fast child settling immediately is also
        // valid — both converge on the poll-driven settled result below.
        const firstJoin = await executeTaskControlAction({
          action: joinAction,
          bundle: STUB_BUNDLE,
          parentTurnId: "turn-join-wait",
          session: taskSession,
        });

        let settledResult = firstJoin.result;
        if (settledResult === undefined) {
          const pendingJoin = firstJoin.pendingJoin as PendingTaskJoin;
          expect(pendingJoin).toEqual({
            callId: "call-join-1",
            resultKey: "tool-call:task_join:call-join-1",
            taskId: pendingTask.taskId,
            taskRunId: pendingTask.taskRunId,
          });

          // The turn workflow's poll arm, driven directly: tick until the
          // child terminates and the join settles with a synthesized result.
          const deadline = Date.now() + 45_000;
          while (settledResult === undefined && Date.now() < deadline) {
            const settled = await pollJoinedTasksStep({
              joins: [pendingJoin],
              sessionState: dispatched.result.sessionState,
            });
            settledResult = settled[0];
            if (settledResult === undefined) {
              await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
          }
        }
        if (settledResult === undefined) {
          throw new Error("Join never settled before the deadline.");
        }
        // The synthesized result carries the originating call's key.
        expect(settledResult).toMatchObject({
          callId: "call-join-1",
          kind: "tool-result",
          toolName: TASK_JOIN_TOOL_NAME,
        });
        const output = settledResult.output as { tasks: Array<{ status: string; taskId: string }> };
        expect(output.tasks[0]).toMatchObject({
          status: "completed",
          taskId: pendingTask.taskId,
        });

        // A second join on the now-terminal task settles immediately.
        const secondJoin = await executeTaskControlAction({
          action: { ...joinAction, callId: "call-join-2" },
          bundle: STUB_BUNDLE,
          parentTurnId: "turn-join-later",
          session: taskSession,
        });
        expect(secondJoin.pendingJoin).toBeUndefined();
        expect(secondJoin.result).toMatchObject({
          callId: "call-join-2",
          output: { tasks: [{ status: "completed", taskId: pendingTask.taskId }] },
        });
      } finally {
        await getRun(handle.address.sessionId)
          .cancel()
          .catch(() => {});
        await getRun(pendingTask.taskRunId)
          .cancel()
          .catch(() => {});
      }
    });
  }, 60_000);
});
