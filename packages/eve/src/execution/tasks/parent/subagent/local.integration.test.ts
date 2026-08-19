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

  it("keeps real task and child ownership when retry siblings reorder", async () => {
    const runtime = createTestRuntime({ agent: { name: "subagent-replay" } });

    await runtime.run(async () => {
      const compiledArtifactsSource = createBundledRuntimeCompiledArtifactsSource();
      const bundle = await getCompiledRuntimeAgentBundle({ compiledArtifactsSource });
      const ctx = new ContextContainer();
      ctx.set(AuthKey, null);
      ctx.set(BundleKey, bundle);
      ctx.set(ChannelKey, { kind: "http", state: {} });
      ctx.set(ContinuationTokenKey, "http:subagent-replay");
      ctx.set(InitiatorAuthKey, null);
      ctx.set(SessionIdKey, "parent-subagent-replay");
      ctx.set(SessionKey, {
        auth: { current: null, initiator: null },
        sessionId: "parent-subagent-replay",
        turn: { id: "turn-subagent-replay", sequence: 1 },
      });

      const session: HarnessSession = setHarnessEmissionState(
        {
          agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
          compaction: { recentWindowSize: 10, threshold: 100_000 },
          continuationToken: "http:subagent-replay",
          history: [],
          sessionId: "parent-subagent-replay",
        },
        { sequence: 1, sessionStarted: true, stepIndex: 0, turnId: "turn-subagent-replay" },
      );
      const tool = createTaskSubagentHarnessDefinition({
        description: "General-purpose agent",
        kind: "subagent",
        name: "agent",
        nodeId: ROOT_RUNTIME_AGENT_NODE_ID,
      });

      const runAttempt = async (
        calls: readonly {
          readonly id: string;
          readonly message: string;
          readonly reverseKeys: boolean;
        }[],
      ) => {
        const model = new MockLanguageModelV4({
          doGenerate: {
            content: calls.map((call) => ({
              input: call.reverseKeys
                ? JSON.stringify({ agentId: null, message: call.message })
                : JSON.stringify({ message: call.message, agentId: null }),
              toolCallId: call.id,
              toolName: "agent",
              type: "tool-call" as const,
            })),
            finishReason: { raw: undefined, unified: "tool-calls" },
            usage,
            warnings: [],
          },
        });
        let generated: Awaited<ReturnType<typeof generateText>> | undefined;
        const stepResult = await contextStorage.run(ctx, () =>
          runWithSubagentToolExecution({
            session,
            step: async () => {
              generated = await generateText({
                model,
                prompt: "Delegate both independent tasks.",
                tools: buildToolSet({ tools: new Map([["agent", tool]]) }),
              });
              return { next: null, session };
            },
          }),
        );
        const handles = getAgentHandleStore(stepResult.session.state)?.handles ?? [];
        const byMessage = Object.fromEntries(
          calls.map((call) => {
            const toolResult = generated?.toolResults.find(
              (result) => result.toolCallId === call.id,
            );
            const output = toolResult?.output;
            if (
              typeof output !== "object" ||
              output === null ||
              !("agentId" in output) ||
              typeof output.agentId !== "string" ||
              !("taskId" in output) ||
              typeof output.taskId !== "string"
            ) {
              throw new Error(`Subagent call "${call.id}" returned no working task receipt.`);
            }
            const handle = handles.find((candidate) => candidate.identity.id === output.agentId);
            if (handle?.phase !== "addressed") {
              throw new Error(`Subagent call "${call.id}" returned no addressed child.`);
            }
            return [
              call.message,
              {
                agentId: output.agentId,
                childSessionId: handle.address.sessionId,
                taskId: output.taskId,
              },
            ];
          }),
        );
        return { byMessage, handles, tasks: stepResult.delegatedTasks ?? [] };
      };

      const research = "Reply with exactly `replay-research-ok`.";
      const writing = "Reply with exactly `replay-writing-ok`.";
      const first = await runAttempt([
        { id: "first-research", message: research, reverseKeys: false },
        { id: "first-writing", message: writing, reverseKeys: false },
      ]);
      const retry = await runAttempt([
        { id: "retry-writing", message: writing, reverseKeys: true },
        { id: "retry-research", message: research, reverseKeys: true },
      ]);

      expect(retry.byMessage).toEqual(first.byMessage);
      expect(new Set(retry.tasks.map((task) => task.taskId))).toEqual(
        new Set(first.tasks.map((task) => task.taskId)),
      );

      try {
        await acknowledgeDelegatedTasksStep({ tasks: retry.tasks });
        await Promise.all(retry.tasks.map((task) => getRun(task.taskRunId).returnValue));
        await expect(
          Promise.all(retry.tasks.map((task) => readLatestTaskView({ taskRunId: task.taskRunId }))),
        ).resolves.toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              lastOutput: { data: expect.stringContaining("replay-research-ok"), type: "result" },
              status: "completed",
            }),
            expect.objectContaining({
              lastOutput: { data: expect.stringContaining("replay-writing-ok"), type: "result" },
              status: "completed",
            }),
          ]),
        );
      } finally {
        const childRunIds = new Set(
          [...first.handles, ...retry.handles].flatMap((handle) =>
            handle.phase === "addressed" ? [handle.address.sessionId] : [],
          ),
        );
        const taskRunIds = new Set([...first.tasks, ...retry.tasks].map((task) => task.taskRunId));
        await Promise.all(
          [...childRunIds, ...taskRunIds].map((runId) =>
            getRun(runId)
              .cancel()
              .catch(() => {}),
          ),
        );
      }
    });
  }, 60_000);
});
