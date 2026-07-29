import { describe, expect, it } from "vitest";

import {
  ProxyTracerProvider,
  trace,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
} from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";
import { adoptGlobalTracerProvider } from "#harness/adopt-global-tracer-provider.js";

describe("adoptGlobalTracerProvider", () => {
  it("declines when the global is not a proxy", () => {
    withGlobalProvider(createInnerProvider([]), () => {
      expect(adoptGlobalTracerProvider(createRecordingProcessor().processor)).toBe(false);
    });
  });

  // What an unclaimed process actually looks like: `getTracerProvider` returns
  // a proxy even when nobody registered, so the proxy shape says nothing on its
  // own. Adopting here would leave eve wrapping the no-op provider and never
  // registering one of its own.
  it("declines a proxy that still delegates to the no-op provider", () => {
    withGlobalProvider(new ProxyTracerProvider(), () => {
      expect(adoptGlobalTracerProvider(createRecordingProcessor().processor)).toBe(false);
    });
  });

  it("routes spans from the adopted provider through the processor", () => {
    const { events, processor } = createRecordingProcessor();
    const proxy = adopt(processor, createInnerProvider(events));

    proxy.getTracer("authored").startSpan("authored.work").end();

    expect(events).toEqual(["start:authored.work", "inner-end:authored.work", "end:authored.work"]);
  });

  it("ends the underlying span exactly once", () => {
    const { events, processor } = createRecordingProcessor();
    const proxy = adopt(processor, createInnerProvider(events));

    const span = proxy.getTracer("authored").startSpan("authored.work");
    span.end();
    span.end();

    expect(events.filter((event) => event.startsWith("inner-end"))).toHaveLength(1);
    expect(events.filter((event) => event.startsWith("end:"))).toHaveLength(1);
  });

  it("leaves sampled-out spans alone", () => {
    const { events, processor } = createRecordingProcessor();
    const proxy = adopt(processor, createInnerProvider([], { recording: false }));

    proxy.getTracer("authored").startSpan("authored.work").end();

    expect(events).toEqual([]);
  });

  // Context activation itself needs a registered context manager, so the
  // scenario tier proves the nesting; this covers the observation wiring.
  it("observes startActiveSpan spans and returns the callback result", () => {
    const { events, processor } = createRecordingProcessor();
    const proxy = adopt(processor, createInnerProvider(events));
    const tracer = proxy.getTracer("authored") as Tracer & {
      startActiveSpan: (name: string, callback: (span: Span) => unknown) => unknown;
    };

    const result = tracer.startActiveSpan("authored.work", (span) => {
      span.end();
      return "done";
    });

    expect(result).toBe("done");
    expect(events).toEqual(["start:authored.work", "inner-end:authored.work", "end:authored.work"]);
  });

  it("reuses one observed tracer per name and version", () => {
    const { processor } = createRecordingProcessor();
    const proxy = adopt(processor, createInnerProvider([]));

    expect(proxy.getTracer("authored", "1")).toBe(proxy.getTracer("authored", "1"));
    expect(proxy.getTracer("authored", "1")).not.toBe(proxy.getTracer("authored", "2"));
  });
});

function adopt(processor: SpanProcessor, delegate: TracerProvider): ProxyTracerProvider {
  const proxy = new ProxyTracerProvider();
  proxy.setDelegate(delegate);
  withGlobalProvider(proxy, () => {
    expect(adoptGlobalTracerProvider(processor)).toBe(true);
  });
  return proxy;
}

/**
 * Stands a provider in for the process global so these tests never mutate
 * OpenTelemetry state that other files in the same worker share.
 */
function withGlobalProvider(provider: TracerProvider, run: () => void): void {
  const restore = trace.getTracerProvider;
  trace.getTracerProvider = () => provider;
  try {
    run();
  } finally {
    trace.getTracerProvider = restore;
  }
}

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
          const span: Span & { name: string } = {
            addEvent: () => span,
            end: () => void events.push(`inner-end:${name}`),
            isRecording: () => options.recording ?? true,
            name,
            recordException: () => {},
            setAttribute: () => span,
            setStatus: () => span,
            spanContext: () => ({ spanId: "b".repeat(16), traceFlags: 1, traceId: "a".repeat(32) }),
          };
          return span;
        },
      };
    },
  };
}
