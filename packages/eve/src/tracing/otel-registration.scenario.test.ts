import { context, propagation, trace, type Context } from "@opentelemetry/api";
import { InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterEach, describe, expect, it, vi } from "vitest";

import { registerOtelPipeline } from "#tracing/otel-registration.js";

afterEach(() => {
  context.disable();
  propagation.disable();
  trace.disable();
});

describe("registerOtelPipeline", () => {
  it("verifies tracer ownership when the sampler records nothing", () => {
    expect(() =>
      registerOtelPipeline({
        pipeline: { sampler: "always_off", spanProcessors: [] },
        serviceName: "weather",
      }),
    ).not.toThrow();
  });

  it("fails when another runtime already owns the global propagator", () => {
    expect(
      propagation.setGlobalPropagator({
        extract: (carrierContext: Context) => carrierContext,
        fields: () => [],
        inject: () => {},
      }),
    ).toBe(true);

    expect(() =>
      registerOtelPipeline({
        pipeline: { spanProcessors: [] },
        serviceName: "weather",
      }),
    ).toThrow(/another runtime already owns the global propagator/u);
  });

  it("does not export the private registration span", async () => {
    const exporter = new InMemorySpanExporter();
    const processor = new SimpleSpanProcessor(exporter);
    const shutdown = vi.spyOn(processor, "shutdown");
    const runtime = registerOtelPipeline({
      pipeline: { spanProcessors: [processor] },
      serviceName: "weather",
    });

    trace.getTracer("test").startSpan("user.work").end();
    await processor.forceFlush();

    expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(["user.work"]);
    await runtime.shutdown();
    expect(shutdown).toHaveBeenCalledOnce();
  });
});
