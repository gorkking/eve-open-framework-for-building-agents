import { describe, expect, it, vi } from "vitest";

import { localTraces } from "#tracing/local-traces.js";

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

describe("localTraces", () => {
  it("reports whether the released session owned any traces", async () => {
    const spool = localTraces({ appRoot: "/tmp/eve-local-traces-test" });
    spool.onStart(agentSpan("session-one", "a".repeat(32)), undefined);

    // A subagent child owns none, so releasing it leaves the trace pinned.
    await expect(spool.releaseSession("child-one")).resolves.toBe(false);
    await expect(spool.releaseSession("session-one")).resolves.toBe(true);
    // Releasing twice is not an error, it just owns nothing the second time.
    await expect(spool.releaseSession("session-one")).resolves.toBe(false);
  });

  it("is a span processor, so it composes wherever one goes", () => {
    const spool = localTraces({ appRoot: "/tmp/eve-local-traces-test" });
    expect(typeof spool.onStart).toBe("function");
    expect(typeof spool.onEnd).toBe("function");
    expect(typeof spool.forceFlush).toBe("function");
    expect(typeof spool.shutdown).toBe("function");
  });
});
