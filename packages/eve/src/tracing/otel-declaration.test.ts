import type { SpanExporter, SpanProcessor } from "#compiled/@vercel/otel/index.js";
import { describe, expect, it } from "vitest";

import {
  agentRunsIntegration,
  collectOtelPipeline,
  isOtelDeclaration,
  isOtelIntegration,
  otel,
  otelIntegration,
} from "#tracing/otel-declaration.js";

/** Collection only ever moves processors, so a fresh no-op is identity enough. */
function processor(): SpanProcessor {
  return {
    forceFlush: async () => undefined,
    onEnd: () => undefined,
    onStart: () => undefined,
    shutdown: async () => undefined,
  };
}

function exporter(): SpanExporter {
  return {
    export: (_spans, resultCallback) => {
      resultCallback({ code: 0 });
    },
    shutdown: async () => undefined,
  };
}

describe("otel", () => {
  it("declares settings without registering anything", () => {
    const declaration = otel({ sampler: "always_on" });
    expect(isOtelDeclaration(declaration)).toBe(true);
    expect(isOtelDeclaration({ options: {} })).toBe(false);
  });
});

describe("otelIntegration", () => {
  it("passes declared processors through untouched", () => {
    const first = processor();
    const integration = otelIntegration({ spanProcessors: [first] });

    expect(isOtelIntegration(integration)).toBe(true);
    expect(integration.spanProcessors).toStrictEqual([first]);
  });

  it("wraps an exporter in a batching processor, after any declared ones", () => {
    const first = processor();
    const integration = otelIntegration({
      spanProcessors: [first],
      traceExporter: exporter(),
    });

    expect(integration.spanProcessors).toHaveLength(2);
    expect(integration.spanProcessors[0]).toBe(first);
  });
});

describe("agentRunsIntegration", () => {
  it("uses Vercel's automatic processor by default", () => {
    const integration = agentRunsIntegration();

    expect(integration.spanProcessors).toStrictEqual(["auto"]);
  });
});

describe("collectOtelPipeline", () => {
  it("reports nothing declared when nothing did", () => {
    expect(collectOtelPipeline([]).declared).toBe(false);
    expect(collectOtelPipeline([{ not: "a declaration" }]).declared).toBe(false);
  });

  it("concatenates destinations in declaration order", () => {
    const [first, second, third] = [processor(), processor(), processor()];
    const collected = collectOtelPipeline([
      otelIntegration({ spanProcessors: [first, second] }),
      otelIntegration({ spanProcessors: [third] }),
      otel(),
    ]);

    expect(collected.declared).toBe(true);
    expect(collected.pipeline.spanProcessors).toStrictEqual([first, second, third]);
  });

  it("is declared by a destination alone, with no otel() beside it", () => {
    const collected = collectOtelPipeline([otelIntegration({ spanProcessors: [processor()] })]);

    expect(collected.declared).toBe(true);
    expect(collected.settings).toStrictEqual({
      functionId: undefined,
      recordInputs: true,
      recordOutputs: true,
      traceChannelRequests: false,
    });
  });

  it("carries the singletons onto the pipeline and the rest onto the settings", () => {
    const collected = collectOtelPipeline([
      otel({
        functionId: "weather",
        propagators: ["tracecontext"],
        resource: { "service.version": "abc" },
        sampler: "always_on",
        traceChannelRequests: true,
      }),
    ]);

    expect(collected.pipeline).toMatchObject({
      propagators: ["tracecontext"],
      resource: { "service.version": "abc" },
      sampler: "always_on",
    });
    expect(collected.settings).toStrictEqual({
      functionId: "weather",
      recordInputs: false,
      recordOutputs: false,
      traceChannelRequests: true,
    });
  });

  // A process has one tracer provider, so letting the first declaration win
  // would silently discard the second — the failure this throw exists to stop.
  it("refuses a second otel() rather than picking one", () => {
    expect(() =>
      collectOtelPipeline([otel({ sampler: "always_on" }), otel({ sampler: "always_off" })]),
    ).toThrow(/declares `otel\(\)` more than once/u);
  });
});
