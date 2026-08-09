import { afterEach, describe, expect, it, vi } from "vitest";

import { createLocalTracesProcessor, resolveLocalTracesContent } from "#tracing/local-traces.js";

vi.mock("#tracing/local-trace-span-processor.js", () => ({
  LocalTraceSpanProcessor: class {
    async forceFlush(): Promise<void> {}
    onEnd(): void {}
    onStart(): void {}
    async shutdown(): Promise<void> {}
  },
}));

vi.mock("#tracing/local-trace-retention.js", () => ({
  requestLocalTraceStorePrune: vi.fn(),
  resolveLocalTraceRetentionSettings: () => ({
    enabled: true,
    maxAgeMs: 1,
    maxTotalBytes: 1,
    retainCount: 1,
  }),
}));

function agentSpan(sessionId: string, traceId: string): unknown {
  return {
    attributes: { "agent.session.id": sessionId },
    spanContext: () => ({ traceId }),
  };
}

describe("createLocalTracesProcessor", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("reports whether the released session owned any traces", async () => {
    const spool = createLocalTracesProcessor({ appRoot: "/tmp/eve-local-traces-test" });
    spool.onStart(agentSpan("session-one", "a".repeat(32)), undefined);

    // A subagent child owns none, so releasing it leaves the trace pinned.
    await expect(spool.releaseSession("child-one")).resolves.toBe(false);
    await expect(spool.releaseSession("session-one")).resolves.toBe(true);
    // Releasing twice is not an error, it just owns nothing the second time.
    await expect(spool.releaseSession("session-one")).resolves.toBe(false);
  });

  it("is a span processor, so it composes wherever one goes", () => {
    const spool = createLocalTracesProcessor({ appRoot: "/tmp/eve-local-traces-test" });
    expect(typeof spool.onStart).toBe("function");
    expect(typeof spool.onEnd).toBe("function");
    expect(typeof spool.forceFlush).toBe("function");
    expect(typeof spool.shutdown).toBe("function");
  });

  it("is inert outside a development worker", async () => {
    vi.stubEnv("EVE_DEV_WORKER_APP_ROOT", undefined);
    const processor = createLocalTracesProcessor();

    expect(() => processor.onEnd(agentSpan("session-one", "a".repeat(32)))).not.toThrow();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
  });

  it("lets the environment override narrow only this destination", () => {
    vi.stubEnv("EVE_TRACES_CONTENT", "off");
    expect(resolveLocalTracesContent()).toEqual({ recordInputs: false, recordOutputs: false });
  });

  it("preserves explicit destination narrowing when content is enabled", () => {
    vi.stubEnv("EVE_TRACES_CONTENT", "on");
    expect(resolveLocalTracesContent({ recordInputs: false })).toEqual({
      recordInputs: false,
      recordOutputs: true,
    });
  });
});
