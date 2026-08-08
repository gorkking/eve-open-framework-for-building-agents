import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  abandonInstrumentationState,
  instrumentationStateSlot,
  isInstrumentationStateAbandoned,
  preserveSerializedInstrumentationState,
  releaseInstrumentationAttemptState,
  releaseInstrumentationState,
} from "#harness/instrumentation-state.js";

describe("instrumentation state", () => {
  it("survives a serialized step boundary", async () => {
    const context = new ContextContainer();
    contextStorage.run(context, () => {
      instrumentationStateSlot("sink", "model:1", { attemptId: "attempt-1" }).set({
        rowId: "row-1",
      });
    });
    const restored = await deserializeContext(await serializeContext(context));
    contextStorage.run(restored, () => {
      expect(instrumentationStateSlot("sink", "model:1").get()).toEqual({ rowId: "row-1" });
    });
  });

  it("isolates providers and operations", () => {
    contextStorage.run(new ContextContainer(), () => {
      instrumentationStateSlot("a", "turn:1").set("a-1");
      instrumentationStateSlot("b", "turn:1").set("b-1");
      instrumentationStateSlot("a", "turn:2").set("a-2");
      expect(instrumentationStateSlot("a", "turn:1").get()).toBe("a-1");
      expect(instrumentationStateSlot("b", "turn:1").get()).toBe("b-1");
      expect(instrumentationStateSlot("a", "turn:2").get()).toBe("a-2");
    });
  });

  it("rejects values that cannot survive serialization", () => {
    contextStorage.run(new ContextContainer(), () => {
      expect(() => instrumentationStateSlot("sink", "turn:1").set(new Date() as never)).toThrow(
        TypeError,
      );
    });
  });

  it("revokes late reads and writes", () => {
    contextStorage.run(new ContextContainer(), () => {
      const lease = instrumentationStateSlot("sink", "turn:1");
      lease.set("before");
      lease.revoke();
      lease.set("after");
      expect(lease.get()).toBeUndefined();
      expect(instrumentationStateSlot("sink", "turn:1").get()).toBe("before");
    });
  });

  it("releases exact and attempt-owned state", () => {
    contextStorage.run(new ContextContainer(), () => {
      instrumentationStateSlot("sink", "model:1", { attemptId: "attempt-1" }).set("one");
      instrumentationStateSlot("sink", "model:2", { attemptId: "attempt-2" }).set("two");
      releaseInstrumentationState("sink", "model:2");
      releaseInstrumentationAttemptState("sink", "attempt-1");
      expect(instrumentationStateSlot("sink", "model:1").get()).toBeUndefined();
      expect(instrumentationStateSlot("sink", "model:2").get()).toBeUndefined();
    });
  });

  it("preserves state from a discarded step", () => {
    expect(
      preserveSerializedInstrumentationState(
        { authored: "original" },
        { "eve.harness.instrumentationState": { state: true } },
      ),
    ).toEqual({
      authored: "original",
      "eve.harness.instrumentationState": { state: true },
    });
  });

  it("persists abandonment across serialization", async () => {
    const context = new ContextContainer();
    contextStorage.run(context, () => {
      abandonInstrumentationState("sink", "model:1", { attemptId: "attempt-1" });
    });
    const restored = await deserializeContext(await serializeContext(context));
    contextStorage.run(restored, () => {
      expect(isInstrumentationStateAbandoned("sink", "model:1")).toBe(true);
    });
  });
});
