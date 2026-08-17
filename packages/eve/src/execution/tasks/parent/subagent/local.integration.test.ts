import { describe, expect, it } from "vitest";

import { getRun } from "#internal/workflow/runtime.js";

import { createDurableSessionState } from "#execution/durable-session-store.js";
import { dispatchLocalSubagentWorkflow } from "#execution/tasks/parent/subagent/dispatch.js";
import { localSubagentWorkflowTool } from "#execution/tasks/parent/subagent/local.js";
import { remoteSubagentWorkflowTool } from "#execution/tasks/parent/subagent/remote.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { setPendingRuntimeActionBatch } from "#harness/runtime-actions.js";
import type { HarnessSession } from "#harness/types.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";

describe("local subagent workflow tool", () => {
  it("is compiled independently from the remote subagent workflow", () => {
    expect(readWorkflowId(localSubagentWorkflowTool.execute)).not.toBe(
      readWorkflowId(remoteSubagentWorkflowTool.execute),
    );
  });

  it("starts a distinct Workflow that dispatches a real local child and task run", async () => {
    const runtime = createTestRuntime({ agent: { name: "subagent-workflow-tool" } });

    await runtime.run(async () => {
      const action = {
        callId: "call-workflow-tool",
        description: "General-purpose agent",
        input: { message: "Reply with exactly `workflow-tool-child-ok`." },
        kind: "subagent-call" as const,
        name: "agent",
        nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
        subagentName: "agent",
      };
      const session: HarnessSession = setPendingRuntimeActionBatch({
        actions: [action],
        event: { sequence: 1, stepIndex: 0, turnId: "turn-workflow-tool" },
        responseMessages: [],
        session: {
          agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
          compaction: { recentWindowSize: 10, threshold: 100_000 },
          continuationToken: "http:subagent-workflow-tool",
          history: [],
          sessionId: "parent-subagent-workflow-tool",
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
          parentContinuationToken: "turn-inbox-subagent-workflow-tool",
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
      const result = dispatched.result.results[0];
      const pendingTask = dispatched.result.pendingTasks[0];
      const handle = getAgentHandleStore(dispatched.result.sessionState.snapshot?.session.state)
        ?.handles[0];
      if (pendingTask === undefined) throw new Error("Workflow tool returned no pending task.");
      if (handle === undefined) throw new Error("Workflow tool returned no local agent handle.");
      if (handle.phase !== "addressed") {
        throw new Error(`Workflow tool returned a child in phase "${handle.phase}".`);
      }

      try {
        expect(result).toMatchObject({
          backgroundTask: { status: "working", taskId: pendingTask.taskId },
          callId: action.callId,
          kind: "subagent-result",
          output: { status: "working", taskId: pendingTask.taskId },
        });
        expect(pendingTask).toMatchObject({
          taskRunId: expect.any(String),
        });
        expect(handle).toMatchObject({
          address: { kind: "agent/self", sessionId: expect.any(String) },
          identity: { name: "agent" },
          phase: "addressed",
        });
        expect(
          new Set([dispatched.workflowRunId, pendingTask.taskRunId, handle.address.sessionId]).size,
        ).toBe(3);
        await expect(getRun(dispatched.workflowRunId).status).resolves.toBe("completed");
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

function readWorkflowId(value: unknown): string {
  if (
    typeof value !== "function" ||
    !("workflowId" in value) ||
    typeof value.workflowId !== "string"
  ) {
    throw new Error("Expected a compiled Workflow function.");
  }
  return value.workflowId;
}
