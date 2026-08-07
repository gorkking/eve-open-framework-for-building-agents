import { beforeEach, describe, expect, it, vi } from "vitest";

import { installInstrumentationRuntime } from "#tracing/install-instrumentation-runtime.js";
import { otelIntegration, collectOtelPipeline } from "#tracing/otel-declaration.js";

const { forceFlush, shutdown } = vi.hoisted(() => ({
  forceFlush: vi.fn(async () => undefined),
  shutdown: vi.fn(async () => undefined),
}));

vi.mock("#tracing/otel-registration.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#tracing/otel-registration.js")>();
  return {
    ...actual,
    registerOtelPipeline: () => ({
      forceFlush,
      idGenerator: {
        allocateSpanId: () => "1".repeat(16),
        withSpanId: (_spanId: string, run: () => unknown) => run(),
      },
      shutdown,
    }),
  };
});

vi.mock("#tracing/agent-otel-provider.js", () => ({
  createAgentOtelInstrumentation: () => ({
    hook: {},
    runInContext: (_operation: unknown, execute: () => PromiseLike<unknown>) => execute(),
  }),
}));

const RUNTIME_GLOBAL_KEY = Symbol.for("eve.instrumentation-runtime");

describe("installInstrumentationRuntime", () => {
  beforeEach(() => {
    forceFlush.mockClear();
    shutdown.mockClear();
    delete (globalThis as Record<symbol, unknown>)[RUNTIME_GLOBAL_KEY];
  });

  it("flushes and shuts down the registered tracer provider", async () => {
    const providerFlush = vi.fn();
    const providerShutdown = vi.fn();
    const runtime = installInstrumentationRuntime({
      collected: collectOtelPipeline([otelIntegration()]),
      frameworkVersion: "test",
      providers: [{ flush: providerFlush, shutdown: providerShutdown }],
      serviceName: "weather",
    });

    await runtime.forceFlush();
    await runtime.shutdown();
    await runtime.shutdown();

    expect(forceFlush).toHaveBeenCalledOnce();
    expect(providerFlush).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(providerShutdown).toHaveBeenCalledOnce();
  });
});
