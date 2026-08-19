import { generateText } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  AuthKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  SessionIdKey,
  SessionKey,
} from "#context/keys.js";
import { createTaskSubagentHarnessDefinition } from "#execution/delegation-tool.js";
import { acknowledgeDelegatedTasksStep } from "#execution/tasks/parent/delegate.js";
import { readLatestTaskView } from "#execution/tasks/parent/run-parent.js";
import { runWithSubagentToolExecution } from "#execution/tasks/parent/subagent/tool-execution.js";
import { getAgentHandleStore } from "#harness/handles/store.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import { buildToolSet } from "#harness/tools.js";
import type { HarnessSession } from "#harness/types.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { getRun } from "#internal/workflow/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { ROOT_RUNTIME_AGENT_NODE_ID } from "#runtime/graph.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

describe("local subagent defineTool execution", () => {
  it("runs AI SDK -> defineTool -> Workflow -> durable task -> local child", async () => {
    const runtime = createTestRuntime({ agent: { name: "subagent-define-tool" } });

    await runtime.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
      const ctx = new ContextContainer();
      ctx.set(AuthKey, null);
      ctx.set(BundleKey, bundle);
      ctx.set(ChannelKey, { kind: "http", state: {} });
      ctx.set(ContinuationTokenKey, "http:subagent-define-tool");
      ctx.set(InitiatorAuthKey, null);
      ctx.set(SessionIdKey, "parent-subagent-define-tool");
      ctx.set(SessionKey, {
        auth: { current: null, initiator: null },
        sessionId: "parent-subagent-define-tool",
        turn: { id: "turn-subagent-define-tool", sequence: 1 },
      });

      const session: HarnessSession = setHarnessEmissionState(
        {
          agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
          compaction: { recentWindowSize: 10, threshold: 100_000 },
          continuationToken: "http:subagent-define-tool",
          history: [],
          sessionId: "parent-subagent-define-tool",
        },
        {
          sequence: 1,
          sessionStarted: true,
          stepIndex: 0,
          turnId: "turn-subagent-define-tool",
        },
      );
      const tool = createTaskSubagentHarnessDefinition({
        description: "General-purpose agent",
        kind: "subagent",
        name: "agent",
        nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      });
      const model = new MockLanguageModelV4({
        doGenerate: {
          content: [
            {
              input: JSON.stringify({
                message: "Reply with exactly `define-tool-child-ok`.",
              }),
              toolCallId: "call-define-tool",
              toolName: "agent",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
      });

      let generated: Awaited<ReturnType<typeof generateText>> | undefined;
      const events: UnstampedMessageStreamEvent[] = [];
      let currentSession = session;
      const stepResult = await contextStorage.run(ctx, () =>
        runWithSubagentToolExecution({
          handleEvent: async (event) => {
            events.push(event);
          },
          session,
          step: async () => {
            const tools = new Map([["agent", tool]]);
            generated = await generateText({
              model,
              prompt: "Delegate the work.",
              tools: buildToolSet({ tools }),
            });
            return { next: null, session: currentSession };
          },
        }),
      );

      const pendingTask = stepResult.delegatedTasks?.[0];
      const handle = getAgentHandleStore(stepResult.session.state)?.handles[0];
      if (pendingTask === undefined) {
        const toolError = generated?.steps[0]?.content.find((part) => part.type === "tool-error");
        if (toolError?.type === "tool-error") throw toolError.error;
        throw new Error("defineTool returned no pending task.");
      }
      if (handle?.phase !== "addressed") throw new Error("defineTool returned no addressed child.");

      try {
        expect(generated?.toolResults[0]).toMatchObject({
          output: {
            agentId: expect.any(String),
            status: "working",
            taskId: pendingTask.taskId,
          },
          toolCallId: "call-define-tool",
          toolName: "agent",
        });
        expect(pendingTask).toMatchObject({ taskRunId: expect.any(String) });
        expect(handle).toMatchObject({
          address: { kind: "agent/self", sessionId: expect.any(String) },
          identity: { name: "agent" },
          phase: "addressed",
        });
        expect(pendingTask.taskRunId).not.toBe(handle.address.sessionId);
        expect(events).toEqual([
          expect.objectContaining({
            data: expect.objectContaining({
              actions: [
                expect.objectContaining({ callId: "call-define-tool", kind: "subagent-call" }),
              ],
            }),
            type: "actions.requested",
          }),
          expect.objectContaining({
            data: expect.objectContaining({ callId: "call-define-tool" }),
            type: "subagent.called",
          }),
          expect.objectContaining({
            data: expect.objectContaining({
              backgroundTask: { status: "working", taskId: pendingTask.taskId },
              callId: "call-define-tool",
            }),
            type: "subagent.completed",
          }),
          expect.objectContaining({
            data: expect.objectContaining({
              result: expect.objectContaining({
                backgroundTask: { status: "working", taskId: pendingTask.taskId },
                callId: "call-define-tool",
                kind: "subagent-result",
              }),
            }),
            type: "action.result",
          }),
        ]);

        await acknowledgeDelegatedTasksStep({ tasks: [pendingTask] });
        await getRun(pendingTask.taskRunId).returnValue;
        await expect(
          readLatestTaskView({ taskRunId: pendingTask.taskRunId }),
        ).resolves.toMatchObject({
          lastOutput: { data: expect.stringContaining("define-tool-child-ok"), type: "result" },
          status: "completed",
          taskId: pendingTask.taskId,
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
