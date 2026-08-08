import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  attemptIdempotencyKey,
  createInstrumentationHooks,
  modelCallIdempotencyKey,
  sessionIdempotencyKey,
  toolCallIdempotencyKey,
  turnIdempotencyKey,
  type InstrumentationAttemptScope,
} from "#harness/instrumentation-lifecycle.js";
import { instrumentationStateSlot } from "#harness/instrumentation-state.js";

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
});
