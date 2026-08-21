import { jsonSchema, type LanguageModel, type ModelMessage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { describe, expect, it, vi } from "vitest";

import {
  buildDynamicTools,
  replayDynamicTools,
  resolveDynamicToolDefinitionForCall,
} from "#context/build-dynamic-tools.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  DynamicToolCallOriginsKey,
  SessionKey,
  TurnDynamicToolMetadataKey,
  type DurableDynamicToolMetadata,
} from "#context/keys.js";
import {
  createDynamicToolOriginState,
  recordDynamicToolCallOrigin,
} from "#harness/dynamic-tool-call-origins.js";
import { appendPendingInputBatch } from "#harness/input-requests.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import { createToolLoopHarness } from "#harness/tool-loop.js";
import { buildToolSetFromDefinitions } from "#harness/tools.js";
import type { HarnessSession, ToolLoopHarnessConfig } from "#harness/types.js";

const usage = {
  inputTokens: { cacheRead: undefined, cacheWrite: undefined, noCache: 1, total: 1 },
  outputTokens: { reasoning: undefined, text: 1, total: 1 },
};

function definition(input: {
  readonly definitionId: string;
  readonly value: string;
}): DurableDynamicToolMetadata {
  return {
    callbacks: {
      approvalRequest: {
        closure: { value: input.value },
        stepId: `approval-${input.definitionId}`,
      },
      execute: {
        closure: { value: input.value },
        stepId: `execute-${input.definitionId}`,
      },
      toModelOutput: {
        closure: { value: input.value },
        stepId: `output-${input.definitionId}`,
      },
    },
    definitionId: input.definitionId,
    description: `Update with ${input.value}`,
    entryKey: "update",
    event: "turn.started",
    inputSchema: { type: "object" },
    name: "update",
    ownerId: "updates",
    resolverSlug: "updates",
    runtimeRevision: `deployment:${input.value}`,
    sourceId: "agent/tools/update.ts",
  };
}

function pendingSession(): HarnessSession {
  const call = {
    input: { id: "item-1" },
    toolCallId: "call-a",
    toolName: "update",
    type: "tool-call" as const,
  };
  return appendPendingInputBatch({
    requests: [
      {
        action: {
          callId: call.toolCallId,
          input: call.input,
          kind: "tool-call",
          toolName: "update",
        },
        allowFreeform: false,
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
        ],
        prompt: "Approve update",
        requestId: "approval-a",
      },
    ],
    responseMessages: [
      {
        content: [
          call,
          { approvalId: "approval-a", toolCallId: call.toolCallId, type: "tool-approval-request" },
        ],
        role: "assistant",
      },
    ],
    session: {
      agent: {
        modelReference: { id: "dynamic-origin-model" },
        system: "Test assistant",
        tools: [{ description: "Update", inputSchema: { type: "object" }, name: "update" }],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "http:dynamic-origin",
      history: [{ content: "Update item-1", role: "user" }],
      sessionId: "dynamic-origin",
    },
  });
}

function installCallbacks(definitions: readonly DurableDynamicToolMetadata[]) {
  const registryKey = Symbol.for("@workflow/core//registeredSteps");
  const global = globalThis as Record<symbol, Map<string, Function> | undefined>;
  const registry = global[registryKey] ?? new Map<string, Function>();
  global[registryKey] = registry;
  const execute = new Map<string, ReturnType<typeof vi.fn>>();
  for (const entry of definitions) {
    const value = entry.runtimeRevision.replace("deployment:", "");
    const callback = vi.fn((closure: { value: string }, toolInput: unknown) => ({
      definition: closure.value,
      toolInput,
    }));
    execute.set(value, callback);
    registry.set(entry.callbacks.execute.stepId, callback);
    registry.set(entry.callbacks.approvalRequest!.stepId, () => "user-approval");
    registry.set(entry.callbacks.toModelOutput!.stepId, (closure: { value: string }) => ({
      type: "text",
      value: `projected:${closure.value}`,
    }));
  }
  return execute;
}

function findToolResult(messages: readonly ModelMessage[]) {
  return messages.flatMap((message) =>
    Array.isArray(message.content)
      ? message.content.filter((part) => part.type === "tool-result")
      : [],
  )[0];
}

describe("dynamic tool call routing", () => {
  it("records, restores, and releases a new dynamic call through the real AI SDK loop", async () => {
    const b = definition({ definitionId: "definition-b", value: "B" });
    const callbacks = installCallbacks([b]);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "dynamic-origin-new-call",
      turn: { id: "turn-b", sequence: 0 },
    });
    ctx.set(TurnDynamicToolMetadataKey, [b]);

    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              input: JSON.stringify({ id: "item-2" }),
              toolCallId: "call-b",
              toolName: "update",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
        {
          content: [{ text: "Updated.", type: "text" }],
          finishReason: { raw: undefined, unified: "stop" },
          usage,
          warnings: [],
        },
      ],
      modelId: "dynamic-origin-model",
      provider: "eve-integration-mock",
    });
    const config: ToolLoopHarnessConfig = {
      mode: "conversation",
      resolveModel: async (): Promise<LanguageModel> => model,
      tools: new Map(),
    };
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "dynamic-origin-model" },
        system: "Test assistant",
        tools: [{ description: "Update", inputSchema: { type: "object" }, name: "update" }],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "http:dynamic-origin-new-call",
      history: [],
      sessionId: "dynamic-origin-new-call",
    };

    const parked = await contextStorage.run(ctx, () =>
      createToolLoopHarness(config)(session, { message: "Update item-2" }),
    );

    expect(callbacks.get("B")).not.toHaveBeenCalled();
    expect(ctx.get(DynamicToolCallOriginsKey)?.calls["call-b"]).toMatchObject({
      definitionId: "definition-b",
    });
    const requestId = getPendingInputBatches(parked.session.state)[0]?.requests[0]?.requestId;
    expect(requestId).toBeTypeOf("string");

    const restored = await deserializeContext(serializeContext(ctx));
    await contextStorage.run(restored, () =>
      createToolLoopHarness(config)(parked.session, {
        inputResponses: [{ optionId: "approve", requestId: requestId! }],
      }),
    );

    expect(callbacks.get("B")).toHaveBeenCalledOnce();
    expect(findToolResult(model.doGenerateCalls[1]?.prompt ?? [])).toMatchObject({
      output: { type: "text", value: "projected:B" },
      toolCallId: "call-b",
      toolName: "update",
    });
    expect(restored.get(DynamicToolCallOriginsKey)).toBeUndefined();
  });

  it("releases a parked origin when approval is denied", async () => {
    const b = definition({ definitionId: "definition-b", value: "B" });
    const callbacks = installCallbacks([b]);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "dynamic-origin-denied",
      turn: { id: "turn-b", sequence: 0 },
    });
    ctx.set(TurnDynamicToolMetadataKey, [b]);
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              input: JSON.stringify({ id: "item-2" }),
              toolCallId: "call-b",
              toolName: "update",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
        {
          content: [{ text: "Cancelled.", type: "text" }],
          finishReason: { raw: undefined, unified: "stop" },
          usage,
          warnings: [],
        },
      ],
      modelId: "dynamic-origin-model",
      provider: "eve-integration-mock",
    });
    const config: ToolLoopHarnessConfig = {
      mode: "conversation",
      resolveModel: async (): Promise<LanguageModel> => model,
      tools: new Map(),
    };
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "dynamic-origin-model" },
        system: "Test assistant",
        tools: [{ description: "Update", inputSchema: { type: "object" }, name: "update" }],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "http:dynamic-origin-denied",
      history: [],
      sessionId: "dynamic-origin-denied",
    };

    const parked = await contextStorage.run(ctx, () =>
      createToolLoopHarness(config)(session, { message: "Update item-2" }),
    );
    const requestId = getPendingInputBatches(parked.session.state)[0]?.requests[0]?.requestId;
    expect(requestId).toBeTypeOf("string");

    await contextStorage.run(ctx, () =>
      createToolLoopHarness(config)(parked.session, {
        inputResponses: [{ optionId: "cancel", requestId: requestId! }],
      }),
    );

    expect(callbacks.get("B")).not.toHaveBeenCalled();
    expect(ctx.get(DynamicToolCallOriginsKey)).toBeUndefined();
  });

  it("releases a new origin after tool execution fails", async () => {
    const b = definition({ definitionId: "definition-b", value: "B" });
    const callbacks = installCallbacks([b]);
    callbacks.get("B")!.mockImplementation(() => {
      throw new Error("execution failed");
    });
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "dynamic-origin-tool-error",
      turn: { id: "turn-b", sequence: 0 },
    });
    ctx.set(TurnDynamicToolMetadataKey, [b]);
    const model = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [
            {
              input: JSON.stringify({ id: "item-2" }),
              toolCallId: "call-b",
              toolName: "update",
              type: "tool-call",
            },
          ],
          finishReason: { raw: undefined, unified: "tool-calls" },
          usage,
          warnings: [],
        },
        {
          content: [{ text: "The update failed.", type: "text" }],
          finishReason: { raw: undefined, unified: "stop" },
          usage,
          warnings: [],
        },
      ],
      modelId: "dynamic-origin-model",
      provider: "eve-integration-mock",
    });
    const config: ToolLoopHarnessConfig = {
      mode: "conversation",
      resolveModel: async (): Promise<LanguageModel> => model,
      tools: new Map(),
    };
    const session: HarnessSession = {
      agent: {
        modelReference: { id: "dynamic-origin-model" },
        system: "Test assistant",
        tools: [{ description: "Update", inputSchema: { type: "object" }, name: "update" }],
      },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: "http:dynamic-origin-tool-error",
      history: [],
      sessionId: "dynamic-origin-tool-error",
    };

    const parked = await contextStorage.run(ctx, () =>
      createToolLoopHarness(config)(session, { message: "Update item-2" }),
    );
    const requestId = getPendingInputBatches(parked.session.state)[0]?.requests[0]?.requestId;
    expect(requestId).toBeTypeOf("string");

    await contextStorage.run(ctx, () =>
      createToolLoopHarness(config)(parked.session, {
        inputResponses: [{ optionId: "approve", requestId: requestId! }],
      }),
    );

    expect(callbacks.get("B")).toHaveBeenCalledOnce();
    expect(ctx.get(DynamicToolCallOriginsKey)).toBeUndefined();
  });

  it("resumes an approved call with A after same-name definition B becomes current", async () => {
    const a = definition({ definitionId: "definition-a", value: "A" });
    const b = definition({ definitionId: "definition-b", value: "B" });
    const callbacks = installCallbacks([a, b]);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "dynamic-origin",
      turn: { id: "turn-b", sequence: 1 },
    });
    ctx.set(TurnDynamicToolMetadataKey, [b]);
    ctx.set(
      DynamicToolCallOriginsKey,
      recordDynamicToolCallOrigin(createDynamicToolOriginState(), a, {
        callId: "call-a",
        originatingStepIndex: 0,
        originatingTurnId: "turn-a",
        toolName: "update",
      }),
    );
    const restored = await deserializeContext(serializeContext(ctx));

    const model = new MockLanguageModelV4({
      doGenerate: {
        content: [{ text: "Updated.", type: "text" }],
        finishReason: { raw: undefined, unified: "stop" },
        usage,
        warnings: [],
      },
      modelId: "dynamic-origin-model",
      provider: "eve-integration-mock",
    });
    const config: ToolLoopHarnessConfig = {
      mode: "conversation",
      resolveModel: async (): Promise<LanguageModel> => model,
      tools: new Map(),
    };

    const resumed = await contextStorage.run(restored, () =>
      createToolLoopHarness(config)(pendingSession(), {
        inputResponses: [{ optionId: "approve", requestId: "approval-a" }],
      }),
    );

    expect(callbacks.get("A")).toHaveBeenCalledOnce();
    expect(callbacks.get("B")).not.toHaveBeenCalled();
    expect(findToolResult(model.doGenerateCalls[0]?.prompt ?? [])).toMatchObject({
      output: { type: "text", value: "projected:A" },
      toolCallId: "call-a",
      toolName: "update",
    });
    expect(resumed.session.history.at(-1)).toMatchObject({ role: "assistant" });
    expect(restored.get(DynamicToolCallOriginsKey)).toBeUndefined();

    const toolSet = buildToolSetFromDefinitions({ tools: buildDynamicTools(restored) });
    const current = toolSet.update!;
    const projected = await contextStorage.run(restored, async () => {
      const output = await current.execute!({ id: "item-2" }, {
        messages: [],
        toolCallId: "call-b",
      } as never);
      return await current.toModelOutput!({ output, toolCallId: "call-b" } as never);
    });

    expect(callbacks.get("B")).toHaveBeenCalledOnce();
    expect(projected).toEqual({ type: "text", value: "projected:B" });
  });

  it("routes a parked dynamic call past a same-name static replacement", async () => {
    const a = definition({ definitionId: "definition-a", value: "A" });
    const callbacks = installCallbacks([a]);
    const staticExecute = vi.fn(() => ({ definition: "static" }));
    const staticOutput = vi.fn(() => ({ type: "text" as const, value: "projected:static" }));
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: null, initiator: null },
      sessionId: "dynamic-origin-static-replacement",
      turn: { id: "turn-b", sequence: 1 },
    });
    ctx.set(
      DynamicToolCallOriginsKey,
      recordDynamicToolCallOrigin(createDynamicToolOriginState(), a, {
        callId: "call-a",
        originatingStepIndex: 0,
        originatingTurnId: "turn-a",
        toolName: "update",
      }),
    );
    const toolSet = buildToolSetFromDefinitions({
      tools: [
        {
          description: "Static update",
          execute: staticExecute,
          inputSchema: jsonSchema({ type: "object" }),
          name: "update",
          toModelOutput: staticOutput,
        },
      ],
    });
    const update = toolSet.update!;

    const projected = await contextStorage.run(ctx, async () => {
      const output = await update.execute!({ id: "item-1" }, {
        messages: [
          {
            content: [
              {
                input: { id: "item-1" },
                toolCallId: "call-a",
                toolName: "update",
                type: "tool-call",
              },
            ],
            role: "assistant",
          },
        ],
        toolCallId: "call-a",
      } as never);
      return await update.toModelOutput!({ output, toolCallId: "call-a" } as never);
    });

    expect(callbacks.get("A")).toHaveBeenCalledOnce();
    expect(staticExecute).not.toHaveBeenCalled();
    expect(staticOutput).not.toHaveBeenCalled();
    expect(projected).toEqual({ type: "text", value: "projected:A" });
  });

  it("fails explicitly when a pending call has no durable origin", () => {
    const b = definition({ definitionId: "definition-b", value: "B" });
    installCallbacks([b]);
    const ctx = new ContextContainer();

    expect(() =>
      contextStorage.run(ctx, () =>
        resolveDynamicToolDefinitionForCall({
          callId: "call-a",
          current: replayDynamicTools([b])[0]!,
          requireOrigin: true,
        }),
      ),
    ).toThrow('Dynamic tool call "call-a" is pending, but its originating definition is missing.');
  });
});
