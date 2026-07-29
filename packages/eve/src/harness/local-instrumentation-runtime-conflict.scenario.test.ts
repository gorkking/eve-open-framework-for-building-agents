import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { registerOTel } from "@vercel/otel";
import { afterEach, describe, expect, it } from "vitest";

import { installLocalInstrumentationRuntime } from "#harness/local-instrumentation-runtime.js";

let appRoot: string | undefined;

afterEach(async () => {
  if (appRoot !== undefined) await rm(appRoot, { force: true, recursive: true });
});

describe("local instrumentation runtime ownership", () => {
  // Stands in for an authored `agent/instrumentation.ts`, which registers
  // before eve's dev plugin runs and resolves `@vercel/otel` from the agent's
  // own dependencies rather than eve's vendored copy. Only one test may
  // install: the runtime is a process global and later calls reuse it.
  it("adopts an authored tracer provider without displacing it", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-local-traces-conflict-"));
    const authoredSpans: string[] = [];
    registerOTel({
      serviceName: "authored-agent",
      spanProcessors: [
        {
          forceFlush: async () => {},
          onEnd: (span: ReadableSpan) => void authoredSpans.push(span.name),
          onStart: () => {},
          shutdown: async () => {},
        },
      ],
    });

    const runtime = installLocalInstrumentationRuntime({
      appRoot,
      frameworkVersion: "test",
      serviceName: "test-agent",
    });
    expect(runtime).toBeDefined();

    const span = trace
      .getTracer("test-agent")
      .startSpan("agent.session", { attributes: { "agent.session.id": "session-1" } });
    const traceId = span.spanContext().traceId;
    span.end();
    await runtime!.forceFlush();

    // The authored exporter keeps every span it received before, and eve
    // additionally spools the agent-owned trace to disk.
    expect(authoredSpans).toContain("agent.session");
    const segments = await readdir(join(appRoot, ".eve", "traces", "v1", traceId, "segments"));
    expect(segments).toHaveLength(1);
  });
});
