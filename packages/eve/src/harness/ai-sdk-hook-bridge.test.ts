import { describe, expect, it, vi } from "vitest";

import { createAiSdkHookBridge } from "#harness/ai-sdk-hook-bridge.js";
import {
  createInstrumentationHooks,
  type InstrumentationAttemptMetadataEvent,
  type InstrumentationAttemptScope,
  type InstrumentationAttemptStartedEvent,
  type InstrumentationModelCallStartedEvent,
  type InstrumentationModelCallTerminalEvent,
  type InstrumentationProviderDefinition,
  type InstrumentationToolCallStartedEvent,
  type InstrumentationToolCallTerminalEvent,
} from "#harness/instrumentation-lifecycle.js";

const scope: InstrumentationAttemptScope = {
  attemptId: "turn-1:step-0:attempt-0",
  attemptIndex: 0,
  sessionId: "session-1",
  stepIndex: 0,
  turnId: "turn-1",
};

describe("createAiSdkHookBridge", () => {
  it("publishes normalized model lifecycle to every provider", async () => {
    const calls: string[] = [];
    const provider = (name: string): InstrumentationProviderDefinition => ({
      events: {
        "model.call": {
          before(event) {
            calls.push(`${name}:before:${event.id}`);
            return `${name}-state`;
          },
          after(event, state) {
            calls.push(`${name}:after:${event.id}:${String(state)}`);
          },
        },
      },
    });
    const hooks = createInstrumentationHooks([provider("a"), provider("b")]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: [], modelId: "model", provider: "test", tools: undefined },
    ]);
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [],
        finishReason: "stop",
        performance: { responseTimeMs: 1 },
        responseId: "response-1",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    const id = `${scope.attemptId}:model:call-1:0`;
    expect(calls).toEqual([
      `a:before:${id}`,
      `b:before:${id}`,
      `a:after:${id}:a-state`,
      `b:after:${id}:b-state`,
    ]);
  });

  it("uses an eve-owned context runner while executing the model exactly once", async () => {
    const order: string[] = [];
    const hooks = createInstrumentationHooks([]);
    const bridge = createAiSdkHookBridge(scope, hooks, async (_operation, execute) => {
      order.push("enter");
      const result = await execute();
      order.push("exit");
      return result;
    });
    const execute = vi.fn(async () => "result");
    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: [], modelId: "model", provider: "test", tools: undefined },
    ]);

    const result = await bridge.executeLanguageModelCall!({
      callId: "call-1",
      execute,
    });

    expect(result).toBe("result");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(order).toEqual(["enter", "exit"]);
  });

  it("passes the identity captured at model-call start to the context runner", async () => {
    const ids: string[] = [];
    const hooks = createInstrumentationHooks([
      { events: { "model.call": { before: (event) => ids.push(event.id) } } },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks, (operation, execute) => {
      ids.push(operation.id);
      return execute();
    });
    Reflect.apply(bridge.onStart!, bridge, [
      { callId: "call-1", modelId: "model", operationId: "ai.streamText", provider: "test" },
    ]);
    await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 0 }]);
    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: [], modelId: "model", provider: "test", tools: undefined },
    ]);
    await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 1 }]);

    await bridge.executeLanguageModelCall!({ callId: "call-1", execute: async () => "result" });

    const expected = `${scope.attemptId}:model:call-1:0`;
    expect(ids).toEqual([expected, expected]);
  });

  it("executes directly when no start identity exists", async () => {
    let adapterCalls = 0;
    const hooks = createInstrumentationHooks([]);
    const bridge = createAiSdkHookBridge(scope, hooks, (_operation, execute) => {
      adapterCalls += 1;
      return execute();
    });
    const execute = vi.fn(async () => "result");

    expect(await bridge.executeLanguageModelCall!({ callId: "missing", execute })).toBe("result");
    expect(execute).toHaveBeenCalledOnce();
    expect(adapterCalls).toBe(0);
  });

  it("publishes step provider metadata as attempt.metadata, skipping steps without any", async () => {
    const events: InstrumentationAttemptMetadataEvent[] = [];
    const hooks = createInstrumentationHooks([
      {
        events: {
          "attempt.metadata": (event) => {
            events.push(event);
          },
        },
      },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onStepEnd!, bridge, [
      { providerMetadata: { gateway: { cost: "0.000082" } } },
    ]);
    await Reflect.apply(bridge.onStepEnd!, bridge, [{ providerMetadata: undefined }]);

    expect(events).toEqual([
      {
        providerMetadata: { gateway: { cost: "0.000082" } },
        scope,
        type: "attempt.metadata",
      },
    ]);
  });

  it("isolates a failing provider from the remaining providers", async () => {
    const after = vi.fn();
    const hooks = createInstrumentationHooks([
      {
        events: {
          "model.call": {
            before() {
              throw new Error("provider failed");
            },
          },
        },
      },
      { events: { "model.call": { before: () => "state", after } } },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: [], modelId: "model", provider: "test", tools: undefined },
    ]);
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [],
        finishReason: "stop",
        performance: { responseTimeMs: 1 },
        responseId: "response-1",
        usage: { inputTokens: 1, outputTokens: 1 },
      },
    ]);

    expect(after).toHaveBeenCalledOnce();
  });

  it("terminalizes started operations when the attempt errors", async () => {
    const after = vi.fn();
    const hooks = createInstrumentationHooks([
      { events: { "model.call": { before: () => "state", after } } },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      { callId: "call-1", messages: [], modelId: "model", provider: "test", tools: undefined },
    ]);
    const error = new Error("model failed");
    await Reflect.apply(bridge.onError!, bridge, [error]);

    expect(after).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ error, type: "model.call.failed" }),
      "state",
    );
  });

  it("publishes an immutable operation projection to every provider", async () => {
    const mutator = vi.fn((event: InstrumentationAttemptStartedEvent) => {
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.operation)).toBe(true);
      expect(Reflect.set(event.operation, "modelId", "corrupted-model")).toBe(false);
      expect(Reflect.set(event.operation, "operationId", "corrupted-operation")).toBe(false);
      expect(Reflect.set(event.operation, "provider", "corrupted-provider")).toBe(false);
    });
    const started = vi.fn();
    const hooks = createInstrumentationHooks([
      { events: { "attempt.started": mutator } },
      { events: { "attempt.started": started } },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    Reflect.apply(bridge.onStart!, bridge, [
      { callId: "call-1", modelId: "model", operationId: "ai.streamText", provider: "test" },
    ]);
    await Reflect.apply(bridge.onStepStart!, bridge, [{ callId: "call-1", stepNumber: 0 }]);

    const expected = {
      operation: { modelId: "model", operationId: "ai.streamText", provider: "test" },
      scope,
      type: "attempt.started",
    };
    expect(mutator).toHaveBeenCalledExactlyOnceWith(expected);
    expect(started).toHaveBeenCalledExactlyOnceWith(expected);
  });

  it("projects the model call callbacks onto eve fields only", async () => {
    const before = vi.fn((event: InstrumentationModelCallStartedEvent) => {
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.input)).toBe(true);
      expect(Object.isFrozen(event.input.messages)).toBe(true);
      expect(Object.isFrozen(event.model)).toBe(true);
      return "state";
    });
    const after = vi.fn((event: InstrumentationModelCallTerminalEvent) => {
      if (event.type !== "model.call.completed") throw new Error("expected completed model call");
      expect(Object.isFrozen(event)).toBe(true);
      expect(Object.isFrozen(event.content)).toBe(true);
      expect(event.content.every((part) => Object.isFrozen(part))).toBe(true);
      expect(Object.isFrozen(event.usage)).toBe(true);
      expect(Object.isFrozen(event.usage.inputTokenDetails)).toBe(true);
    });
    const hooks = createInstrumentationHooks([{ events: { "model.call": { after, before } } }]);
    const bridge = createAiSdkHookBridge(scope, hooks);

    await Reflect.apply(bridge.onLanguageModelCallStart!, bridge, [
      {
        callId: "call-1",
        instructions: "be brief",
        messages: [{ content: "hi", role: "user" }],
        modelId: "model",
        provider: "test",
        tools: undefined,
      },
    ]);
    await Reflect.apply(bridge.onLanguageModelCallEnd!, bridge, [
      {
        callId: "call-1",
        content: [
          { text: "thinking", type: "reasoning" },
          { text: "hello", type: "text" },
          { input: { a: 1 }, toolName: "search", type: "tool-call" },
          { input: { a: 1 }, output: "ok", toolName: "search", type: "tool-result" },
          { error: "boom", input: { a: 2 }, toolName: "search", type: "tool-error" },
          { type: "some-future-kind" },
        ],
        finishReason: "tool-calls",
        performance: { responseTimeMs: 1 },
        responseId: "response-1",
        usage: {
          inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 4 },
          inputTokens: 1,
          outputTokens: 2,
        },
      },
    ]);

    expect(before).toHaveBeenCalledExactlyOnceWith({
      id: `${scope.attemptId}:model:call-1:0`,
      input: { instructions: "be brief", messages: [{ content: "hi", role: "user" }] },
      model: { modelId: "model", provider: "test" },
      scope,
      type: "model.call.started",
    });
    // An unrecognized part kind is dropped rather than forwarded, so widening
    // InstrumentationContentPart is what makes a new kind reachable.
    expect(after).toHaveBeenCalledExactlyOnceWith(
      {
        content: [
          { text: "thinking", type: "reasoning" },
          { text: "hello", type: "text" },
          { input: { a: 1 }, toolName: "search", type: "tool-call" },
          { input: { a: 1 }, output: "ok", toolName: "search", type: "tool-result" },
          { error: "boom", input: { a: 2 }, toolName: "search", type: "tool-error" },
        ],
        finishReason: "tool-calls",
        id: `${scope.attemptId}:model:call-1:0`,
        scope,
        type: "model.call.completed",
        usage: {
          inputTokenDetails: { cacheReadTokens: 3, cacheWriteTokens: 4 },
          inputTokens: 1,
          outputTokens: 2,
        },
      },
      "state",
    );
  });

  it.each([
    {
      expected: { output: "ok", type: "result" },
      toolOutput: { output: "ok", type: "tool-result" },
    },
    {
      expected: { error: "boom", type: "error" },
      toolOutput: { error: "boom", type: "tool-error" },
    },
  ])(
    "collapses tool output $toolOutput.type onto $expected.type",
    async ({ expected, toolOutput }) => {
      const before = vi.fn((event: InstrumentationToolCallStartedEvent) => {
        expect(Object.isFrozen(event)).toBe(true);
        return "state";
      });
      const after = vi.fn((event: InstrumentationToolCallTerminalEvent) => {
        if (event.type !== "tool.call.completed") throw new Error("expected completed tool call");
        expect(Object.isFrozen(event)).toBe(true);
        expect(Object.isFrozen(event.output)).toBe(true);
      });
      const hooks = createInstrumentationHooks([{ events: { "tool.call": { after, before } } }]);
      const bridge = createAiSdkHookBridge(scope, hooks);
      const toolCall = { input: { q: "eve" }, toolCallId: "tool-1", toolName: "search" };

      await Reflect.apply(bridge.onToolExecutionStart!, bridge, [{ callId: "call-1", toolCall }]);
      await Reflect.apply(bridge.onToolExecutionEnd!, bridge, [
        { callId: "call-1", toolCall, toolExecutionMs: 1, toolOutput },
      ]);

      expect(before).toHaveBeenCalledExactlyOnceWith({
        callId: "tool-1",
        id: `${scope.attemptId}:tool:tool-1:0`,
        input: { q: "eve" },
        scope,
        toolName: "search",
        type: "tool.call.started",
      });
      expect(after).toHaveBeenCalledExactlyOnceWith(
        {
          id: `${scope.attemptId}:tool:tool-1:0`,
          output: expected,
          scope,
          type: "tool.call.completed",
        },
        "state",
      );
    },
  );

  it("retains state for parallel tool starts", async () => {
    const resolvers = new Map<string, () => void>();
    const terminalStates = new Map<string, unknown>();
    const hooks = createInstrumentationHooks([
      {
        events: {
          "tool.call": {
            before(event) {
              return new Promise<string>((resolve) => {
                resolvers.set(event.id, () => resolve(`state:${event.id}`));
              });
            },
            after(event, state) {
              terminalStates.set(event.id, state);
            },
          },
        },
      },
    ]);
    const bridge = createAiSdkHookBridge(scope, hooks);
    const start = (toolCallId: string) =>
      Reflect.apply(bridge.onToolExecutionStart!, bridge, [
        {
          callId: "call-1",
          toolCall: { input: {}, toolCallId, toolName: "search" },
        },
      ]);
    const first = start("tool-1");
    const second = start("tool-2");
    await vi.waitFor(() => expect(resolvers.size).toBe(2));

    const firstId = `${scope.attemptId}:tool:tool-1:0`;
    const secondId = `${scope.attemptId}:tool:tool-2:0`;
    resolvers.get(secondId)!();
    resolvers.get(firstId)!();
    await Promise.all([first, second]);

    const end = (toolCallId: string) =>
      Reflect.apply(bridge.onToolExecutionEnd!, bridge, [
        {
          callId: "call-1",
          messages: [],
          toolCall: { input: {}, toolCallId, toolName: "search" },
          toolExecutionMs: 1,
          toolOutput: { output: {}, type: "tool-result" },
        },
      ]);
    await Promise.all([end("tool-1"), end("tool-2")]);

    expect(terminalStates).toEqual(
      new Map([
        [firstId, `state:${firstId}`],
        [secondId, `state:${secondId}`],
      ]),
    );
  });
});
