import { describe, expect, it, vi } from "vitest";

import { contentFilteringProcessor } from "#tracing/content-span-processor.js";

describe("contentFilteringProcessor", () => {
  it("gives one destination a redacted copy without mutating the shared span", () => {
    const onEnd = vi.fn();
    const downstream = {
      forceFlush: async () => undefined,
      onEnd,
      onStart: () => undefined,
      shutdown: async () => undefined,
    };
    const processor = contentFilteringProcessor(downstream, {
      recordInputs: false,
      recordOutputs: true,
    });
    const span = {
      attributes: {
        "ai.prompt.messages": "secret",
        "ai.response.text": "answer",
        "service.name": "weather",
      },
      spanContext: () => ({ traceFlags: 1 }),
    };

    processor.onEnd(span);

    expect(onEnd.mock.calls[0]?.[0].attributes).toStrictEqual({
      "ai.response.text": "answer",
      "service.name": "weather",
    });
    expect(span.attributes).toHaveProperty("ai.prompt.messages", "secret");
  });
});
