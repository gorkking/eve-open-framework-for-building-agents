import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  actionIdempotencyKey,
  attemptIdempotencyKey,
  createInstrumentationHooks,
  modelCallIdempotencyKey,
  sessionIdempotencyKey,
  toolCallIdempotencyKey,
  turnIdempotencyKey,
  type InstrumentationAttemptScope,
  type InstrumentationToolCallCompletedEvent,
} from "#harness/instrumentation-lifecycle.js";
import {
  findInstrumentationActionScopeForCall,
  instrumentationStateSlot,
  rememberInstrumentationActionScope,
} from "#harness/instrumentation-state.js";

const scope: InstrumentationAttemptScope = {
  attemptId: "session-1:turn-1:0:0",
  attemptIndex: 0,
  sessionId: "session-1",
  stepIndex: 0,
  turnId: "turn-1",
};

describe("instrumentation idempotency keys", () => {
  it("separates classes that share an identifier", () => {
    expect(sessionIdempotencyKey("shared")).not.toBe(turnIdempotencyKey("shared", "shared"));
  });

  it("separates identical turn IDs in different sessions", () => {
    expect(turnIdempotencyKey("session-1", "turn_0")).not.toBe(
      turnIdempotencyKey("session-2", "turn_0"),
    );
  });

  it("derives model identity without an AI SDK call ID", () => {
    expect(modelCallIdempotencyKey(scope, 2)).toBe("model:session-1:turn-1:0:0:2");
  });

  it("separates model attempts and SDK tool calls", () => {
    const retry = { ...scope, attemptId: "session-1:turn-1:0:1", attemptIndex: 1 };
    expect(attemptIdempotencyKey(scope)).not.toBe(attemptIdempotencyKey(retry));
    expect(modelCallIdempotencyKey(scope, 0)).not.toBe(toolCallIdempotencyKey(scope, "call-1", 0));
  });
});

describe("provider state lifecycle", () => {
  const started = {
    idempotencyKey: turnIdempotencyKey("session-1", "turn-1"),
    rootSessionId: "session-1",
    sequence: 0,
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.started" as const,
  };
  const completed = {
    idempotencyKey: started.idempotencyKey,
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.completed" as const,
  };

  it("carries a value from a start to its terminal and releases it", async () => {
    let observed: unknown;
    const hooks = createInstrumentationHooks([
      {
        events: {
          "turn.completed": (_event, ctx) => {
            observed = ctx.state.get();
          },
          "turn.started": (_event, ctx) => ctx.state.set({ rowId: "row-1" }),
        },
        name: "sink",
      },
    ]);

    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish(started);
      await hooks.publish(completed);
      expect(instrumentationStateSlot("sink", started.idempotencyKey).get()).toBeUndefined();
    });
    expect(observed).toEqual({ rowId: "row-1" });
  });

  it("releases state when no terminal handler exists", async () => {
    const hooks = createInstrumentationHooks([
      { events: { "turn.started": (_event, ctx) => ctx.state.set("open") }, name: "sink" },
    ]);
    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish(started);
      await hooks.publish(completed);
      expect(instrumentationStateSlot("sink", started.idempotencyKey).get()).toBeUndefined();
    });
  });

  it("releases unterminated model state when its attempt ends", async () => {
    const modelKey = modelCallIdempotencyKey(scope, 0);
    const hooks = createInstrumentationHooks([
      {
        events: { "model.call.started": (_event, ctx) => ctx.state.set("open") },
        name: "sink",
      },
    ]);
    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish({
        idempotencyKey: modelKey,
        input: { messages: [] },
        model: { modelId: "model", provider: "test" },
        scope,
        type: "model.call.started",
      });
      await hooks.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        scope,
        type: "step.attempt.completed",
      });
      expect(instrumentationStateSlot("sink", modelKey).get()).toBeUndefined();
    });
  });

  it("keeps action state past the originating attempt", async () => {
    const actionKey = actionIdempotencyKey(scope.sessionId, scope.turnId, "call-1");
    const hooks = createInstrumentationHooks([
      {
        events: { "action.started": (_event, ctx) => ctx.state.set("open") },
        name: "sink",
      },
    ]);
    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish({
        callId: "call-1",
        idempotencyKey: actionKey,
        input: {},
        kind: "tool-call",
        name: "tool",
        scope,
        type: "action.started",
      });
      await hooks.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        scope,
        type: "step.attempt.completed",
      });
      expect(instrumentationStateSlot("sink", actionKey).get()).toBe("open");
    });
  });

  it("terminalizes and releases pending actions when a turn is cancelled", async () => {
    const actionKey = actionIdempotencyKey(scope.sessionId, scope.turnId, "call-1");
    const failed = vi.fn();
    const hooks = createInstrumentationHooks([
      {
        events: {
          "action.failed": failed,
          "action.started": (_event, ctx) => ctx.state.set("open"),
        },
        name: "sink",
      },
    ]);
    await contextStorage.run(new ContextContainer(), async () => {
      rememberInstrumentationActionScope(actionKey, scope);
      await hooks.publish({
        callId: "call-1",
        idempotencyKey: actionKey,
        input: {},
        kind: "tool-call",
        name: "tool",
        scope,
        type: "action.started",
      });
      await hooks.publish({
        idempotencyKey: turnIdempotencyKey(scope.sessionId, scope.turnId),
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        type: "turn.cancelled",
      });
      expect(instrumentationStateSlot("sink", actionKey).get()).toBeUndefined();
      expect(findInstrumentationActionScopeForCall(scope.sessionId, "call-1")).toBeUndefined();
    });
    expect(failed).toHaveBeenCalledOnce();
  });
});

describe("provider handler deadlines", () => {
  const key = turnIdempotencyKey("session-1", "turn-1");
  const started = {
    idempotencyKey: key,
    rootSessionId: "session-1",
    sequence: 0,
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.started" as const,
  };
  const completed = {
    idempotencyKey: key,
    sessionId: "session-1",
    turnId: "turn-1",
    type: "turn.completed" as const,
  };
  const hang = () => new Promise<void>(() => {});

  it("lets providers behind a hanging handler run", async () => {
    const after = vi.fn();
    const hooks = createInstrumentationHooks(
      [
        { events: { "turn.started": hang }, name: "hangs" },
        { events: { "turn.started": after }, name: "after" },
      ],
      { handlerTimeoutMs: 1 },
    );
    await contextStorage.run(new ContextContainer(), () => hooks.publish(started));
    expect(after).toHaveBeenCalledOnce();
  });

  it("persists abandonment across workers and skips the terminal", async () => {
    const terminal = vi.fn();
    const context = new ContextContainer();
    const starts = createInstrumentationHooks(
      [{ events: { "turn.started": hang }, name: "sink" }],
      { handlerTimeoutMs: 1 },
    );
    await contextStorage.run(context, () => starts.publish(started));

    const restored = await deserializeContext(await serializeContext(context));
    const terminals = createInstrumentationHooks(
      [{ events: { "turn.completed": terminal }, name: "sink" }],
      { handlerTimeoutMs: 1 },
    );
    await contextStorage.run(restored, () => terminals.publish(completed));
    expect(terminal).not.toHaveBeenCalled();
  });

  it("ignores a timed-out handler's late state write", async () => {
    let resume!: () => void;
    const continued = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const hooks = createInstrumentationHooks(
      [
        {
          events: {
            "turn.started": async (_event, ctx) => {
              await continued;
              ctx.state.set("late");
            },
          },
          name: "slow",
        },
      ],
      { handlerTimeoutMs: 1 },
    );
    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish(started);
      await hooks.publish(completed);
      resume();
      await continued;
      await Promise.resolve();
      expect(instrumentationStateSlot("slow", key).get()).toBeUndefined();
    });
  });

  it("does not abandon an operation for a point-event timeout", async () => {
    const terminal = vi.fn();
    const hooks = createInstrumentationHooks(
      [
        {
          events: {
            "step.attempt.completed": terminal,
            "step.attempt.metadata": hang,
          },
          name: "slow-metadata",
        },
      ],
      { handlerTimeoutMs: 1 },
    );
    await contextStorage.run(new ContextContainer(), async () => {
      await hooks.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        providerMetadata: {},
        scope,
        type: "step.attempt.metadata",
      });
      await hooks.publish({
        idempotencyKey: attemptIdempotencyKey(scope),
        scope,
        type: "step.attempt.completed",
      });
    });
    expect(terminal).toHaveBeenCalledOnce();
  });
});

describe("capture", () => {
  it("reports content capture only when some provider asked for it", () => {
    expect(createInstrumentationHooks([{ name: "quiet" }]).capturesContent).toBe(false);
    expect(
      createInstrumentationHooks([{ capture: "metadata", name: "quiet" }, { name: "also-quiet" }])
        .capturesContent,
    ).toBe(false);
    expect(
      createInstrumentationHooks([{ name: "quiet" }, { capture: "content", name: "loud" }])
        .capturesContent,
    ).toBe(true);
  });

  it("allows only structural provider metadata by default", async () => {
    const metadataOnly = vi.fn();
    const wantsContent = vi.fn();
    const hooks = createInstrumentationHooks([
      { events: { "step.attempt.metadata": metadataOnly }, name: "metadata" },
      {
        capture: "content",
        events: { "step.attempt.metadata": wantsContent },
        name: "content",
      },
    ]);
    const providerMetadata = {
      gateway: {
        cost: "0.01",
        generationId: "generation-1",
        groundingSegments: ["private result"],
      },
      google: { searchQueries: ["private query"], thoughtSignature: "private signature" },
    };

    await hooks.publish({
      idempotencyKey: attemptIdempotencyKey(scope),
      providerMetadata,
      scope,
      type: "step.attempt.metadata",
    });

    const visible = metadataOnly.mock.calls[0]?.[0];
    expect(visible.providerMetadata).toEqual({
      gateway: { cost: "0.01", generationId: "generation-1" },
    });
    expect(Object.isFrozen(visible)).toBe(true);
    expect(Object.isFrozen(visible.providerMetadata)).toBe(true);
    expect(Object.isFrozen(visible.providerMetadata.gateway)).toBe(true);
    expect(wantsContent.mock.calls[0]?.[0].providerMetadata).toBe(providerMetadata);
  });

  it("withholds failure details from metadata providers", async () => {
    const metadataOnly = vi.fn();
    const wantsContent = vi.fn();
    const hooks = createInstrumentationHooks([
      { events: { "action.failed": metadataOnly }, name: "metadata" },
      { capture: "content", events: { "action.failed": wantsContent }, name: "content" },
    ]);
    const error = { output: "private tool output", requestBody: "private request" };
    const actionScope = { ...scope };

    await hooks.publish({
      error,
      idempotencyKey: actionIdempotencyKey(scope.sessionId, scope.turnId, "call-1"),
      scope: actionScope,
      type: "action.failed",
    });

    expect(metadataOnly.mock.calls[0]?.[0]).toMatchObject({
      error: undefined,
      type: "action.failed",
    });
    expect(Object.isFrozen(metadataOnly.mock.calls[0]?.[0])).toBe(true);
    expect(wantsContent.mock.calls[0]?.[0].error).toBe(error);
  });

  it("freezes one stripped projection shared by metadata providers", async () => {
    const observed = vi.fn();
    const mutator = vi.fn((event: InstrumentationToolCallCompletedEvent) => {
      expect(Reflect.set(event, "finishReason", "corrupted")).toBe(false);
      expect(Reflect.set(event.output, "type", "error")).toBe(false);
    });
    const hooks = createInstrumentationHooks([
      { events: { "tool.call.completed": mutator }, name: "first" },
      { events: { "tool.call.completed": observed }, name: "second" },
      { capture: "content", name: "content" },
    ]);

    await hooks.publish({
      idempotencyKey: toolCallIdempotencyKey(scope, "call-1", 0),
      output: { output: "private", type: "result" },
      scope,
      type: "tool.call.completed",
    });

    expect(observed.mock.calls[0]?.[0].output).toEqual({ type: "result" });
    expect(Object.isFrozen(observed.mock.calls[0]?.[0])).toBe(true);
    expect(Object.isFrozen(observed.mock.calls[0]?.[0].output)).toBe(true);
  });
});
