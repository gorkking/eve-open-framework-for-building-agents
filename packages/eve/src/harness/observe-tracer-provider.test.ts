import { describe, expect, it } from "vitest";

import type {
  Context,
  Span,
  SpanOptions,
  Tracer,
  TracerProvider,
} from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";
import { observeTracerProvider } from "#harness/observe-tracer-provider.js";

describe("observeTracerProvider", () => {
  it("routes spans from the observed provider through the processor", () => {
    const { events, processor } = createRecordingProcessor();
    const provider = observeTracerProvider(createInnerProvider(events), () => processor);

    provider.getTracer("authored").startSpan("authored.work").end();

    expect(events).toEqual(["start:authored.work", "inner-end:authored.work", "end:authored.work"]);
  });

  it("ends the underlying span exactly once", () => {
    const { events, processor } = createRecordingProcessor();
    const provider = observeTracerProvider(createInnerProvider(events), () => processor);

    const span = provider.getTracer("authored").startSpan("authored.work");
    span.end();
    span.end();

    expect(events.filter((event) => event.startsWith("inner-end"))).toHaveLength(1);
    expect(events.filter((event) => event.startsWith("end:"))).toHaveLength(1);
  });

  it("leaves sampled-out spans alone", () => {
    const { events, processor } = createRecordingProcessor();
    const provider = observeTracerProvider(
      createInnerProvider([], { recording: false }),
      () => processor,
    );

    provider.getTracer("authored").startSpan("authored.work").end();

    expect(events).toEqual([]);
  });

  // Interception is installed before the trace writer exists, so the window
  // between them has to be a pass-through rather than a crash.
  it("passes spans through while no processor is attached", () => {
    const events: string[] = [];
    const provider = observeTracerProvider(createInnerProvider(events), () => undefined);

    provider.getTracer("authored").startSpan("authored.work").end();

    expect(events).toEqual(["inner-end:authored.work"]);
  });

  // Context activation itself needs a registered context manager, so the
  // scenario tier proves the nesting; this covers the observation wiring.
  it("observes startActiveSpan spans and returns the callback result", () => {
    const { events, processor } = createRecordingProcessor();
    const provider = observeTracerProvider(createInnerProvider(events), () => processor);
    const tracer = provider.getTracer("authored") as Tracer & {
      startActiveSpan: (name: string, callback: (span: Span) => unknown) => unknown;
    };

    const result = tracer.startActiveSpan("authored.work", (span) => {
      span.end();
      return "done";
    });

    expect(result).toBe("done");
    expect(events).toEqual(["start:authored.work", "inner-end:authored.work", "end:authored.work"]);
  });

  // A tracer's identity is (name, version, options) including options.schemaUrl,
  // so there is no key eve can cache on without handing back a wrapper over the
  // wrong delegate tracer.
  it("wraps each requested tracer independently", () => {
    const { events, processor } = createRecordingProcessor();
    const provider = observeTracerProvider(createInnerProvider(events), () => processor);

    expect(provider.getTracer("authored", "1")).not.toBe(provider.getTracer("authored", "1"));

    provider
      .getTracer("authored", "1", { schemaUrl: "https://example.test/a" })
      .startSpan("a")
      .end();
    provider
      .getTracer("authored", "1", { schemaUrl: "https://example.test/b" })
      .startSpan("b")
      .end();

    expect(events.filter((event) => event.startsWith("start:"))).toEqual(["start:a", "start:b"]);
  });

  describe("span ownership", () => {
    it("does not mutate the span it observes", () => {
      const { events, processor } = createRecordingProcessor();
      const raw = createSpan("authored.work", events, true);
      const originalEnd = raw.end;
      const provider = observeTracerProvider(
        { getTracer: () => ({ startSpan: () => raw }) },
        () => processor,
      );

      const observed = provider.getTracer("authored").startSpan("authored.work");
      observed.end();

      expect(observed).not.toBe(raw);
      expect(Object.hasOwn(raw, "end")).toBe(false);
      expect(raw.end).toBe(originalEnd);
    });

    // The OTel API contracts nothing about spans being extensible. Assigning
    // over `end` used to be how eve observed them, which threw here.
    it("observes a frozen span whose end comes from its prototype", () => {
      const { events, processor } = createRecordingProcessor();
      const provider = observeTracerProvider(createFrozenSpanProvider(events), () => processor);

      const span = provider.getTracer("authored").startSpan("authored.work");
      span.setAttribute("key", "value").end();

      expect(events).toEqual([
        "start:authored.work",
        "inner-end:authored.work",
        "end:authored.work",
      ]);
    });

    // A frozen own `end` cannot be substituted by a proxy at all, so eve
    // declines the span rather than throwing on the way past.
    it("declines a span whose end cannot be intercepted", () => {
      const { events, processor } = createRecordingProcessor();
      const provider = observeTracerProvider(createSealedEndProvider(events), () => processor);

      provider.getTracer("authored").startSpan("authored.work").end();

      // The span still works; eve simply reports neither half of it.
      expect(events).toEqual(["inner-end:authored.work"]);
    });

    it("forwards data properties to the observed span", () => {
      const { processor } = createRecordingProcessor();
      const provider = observeTracerProvider(createInnerProvider([]), () => processor);

      const span = provider.getTracer("authored").startSpan("authored.work") as Span & {
        name: string;
      };

      expect(span.name).toBe("authored.work");
      expect(span.spanContext().traceId).toBe("a".repeat(32));
    });
  });
});

function createRecordingProcessor(): { events: string[]; processor: SpanProcessor } {
  const events: string[] = [];
  return {
    events,
    processor: {
      forceFlush: async () => {},
      onEnd: (span: unknown) => void events.push(`end:${(span as { name: string }).name}`),
      onStart: (span: unknown) => void events.push(`start:${(span as { name: string }).name}`),
      shutdown: async () => {},
    },
  };
}

function createInnerProvider(
  events: string[],
  options: { recording?: boolean } = {},
): TracerProvider {
  return {
    getTracer(): Tracer {
      return {
        startSpan(name: string, _options?: SpanOptions, _parentContext?: Context): Span {
          return createSpan(name, events, options.recording ?? true);
        },
      };
    },
  };
}

/** Methods on a prototype, instance frozen: what a hardened SDK span looks like. */
function createFrozenSpanProvider(events: string[]): TracerProvider {
  return {
    getTracer(): Tracer {
      return {
        startSpan(name: string): Span {
          return Object.freeze(createSpan(name, events, true));
        },
      };
    },
  };
}

/** `end` as a frozen own property, which no proxy is allowed to substitute. */
function createSealedEndProvider(events: string[]): TracerProvider {
  return {
    getTracer(): Tracer {
      return {
        startSpan(name: string): Span {
          const span = createSpan(name, events, true);
          Object.defineProperty(span, "end", {
            configurable: false,
            value: () => void events.push(`inner-end:${name}`),
            writable: false,
          });
          return span;
        },
      };
    },
  };
}

function createSpan(name: string, events: string[], recording: boolean): Span & { name: string } {
  // Prototype-held methods, as every real span implementation has.
  const behavior = {
    addEvent(this: Span): Span {
      return this;
    },
    end(): void {
      events.push(`inner-end:${name}`);
    },
    isRecording(): boolean {
      return recording;
    },
    recordException(): void {},
    setAttribute(this: Span): Span {
      return this;
    },
    setStatus(this: Span): Span {
      return this;
    },
    spanContext() {
      return { spanId: "b".repeat(16), traceFlags: 1, traceId: "a".repeat(32) };
    },
  };
  return Object.create(behavior, { name: { enumerable: true, value: name } }) as Span & {
    name: string;
  };
}
