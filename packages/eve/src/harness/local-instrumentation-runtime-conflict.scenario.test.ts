import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { context, trace } from "@opentelemetry/api";
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { registerOTel } from "@vercel/otel";
import { afterEach, describe, expect, it } from "vitest";

import {
  installGlobalTracerProviderInterception,
  releaseGlobalTracerProviderInterception,
} from "#harness/intercept-global-tracer-provider.js";
import { installLocalInstrumentationRuntime } from "#harness/local-instrumentation-runtime.js";

let appRoot: string | undefined;

afterEach(async () => {
  releaseGlobalTracerProviderInterception();
  if (appRoot !== undefined) await rm(appRoot, { force: true, recursive: true });
});

describe("local instrumentation runtime ownership", () => {
  // Stands in for an authored `agent/instrumentation.ts`, which registers
  // between eve's two dev plugins and resolves `@vercel/otel` and
  // `@opentelemetry/api` from the agent's own dependencies rather than eve's
  // vendored copies — the interception has to work across those two module
  // instances. Only one test may install: the runtime is a process global and
  // later calls reuse it.
  it("observes an authored tracer provider without displacing it", async () => {
    appRoot = await mkdtemp(join(tmpdir(), "eve-local-traces-conflict-"));

    expect(installGlobalTracerProviderInterception()).toBe(true);

    // Taken before anything registers a provider, which is what an authored
    // module that acquires a tracer at import time does. The API hands back a
    // proxy tracer bound to its own standby provider, so swapping the global
    // provider after the fact could not reach it — only hooking the delegate.
    const earlyTracer = trace.getTracer("test-agent");

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

    const span = earlyTracer.startSpan("agent.session", {
      attributes: { "agent.session.id": "session-1" },
    });
    const traceId = span.spanContext().traceId;

    // The Workflow SDK asks the global API for a `workflow` tracer, so its spans
    // arrive by the same route as everything else — and when a tool starts a run
    // they are children of the agent's span, inside a trace eve owns. Scope name
    // is what keeps them out of the local store: `eve trace` shows a session's
    // own work, and a run's spans belong to the run's trace. The author's
    // exporter still receives them; eve observes their provider, it does not
    // filter it.
    const workflowSpan = trace
      .getTracer("workflow")
      .startSpan("step.execute", {}, trace.setSpan(context.active(), span));
    workflowSpan.end();
    span.end();
    await runtime!.forceFlush();

    // The authored exporter keeps every span it received before, and eve
    // additionally spools the agent-owned trace to disk.
    expect(authoredSpans).toContain("agent.session");
    expect(authoredSpans).toContain("step.execute");
    expect(workflowSpan.spanContext().traceId).toBe(traceId);

    const stored = await readStoredTrace(appRoot, traceId);
    expect(stored.spanNames).toEqual(["agent.session"]);
    expect(stored.scopeNames).not.toContain("workflow");
  });
});

interface StoredTrace {
  readonly scopeNames: readonly string[];
  readonly spanNames: readonly string[];
}

async function readStoredTrace(appRoot: string, traceId: string): Promise<StoredTrace> {
  const segmentsDirectory = join(appRoot, ".eve", "traces", "v1", traceId, "segments");
  const scopeNames: string[] = [];
  const spanNames: string[] = [];

  for (const segment of await readdir(segmentsDirectory)) {
    const payload = JSON.parse(
      await readFile(join(segmentsDirectory, segment), "utf8"),
    ) as OtlpSegment;
    for (const resourceSpan of payload.resourceSpans ?? []) {
      for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
        if (scopeSpan.scope?.name !== undefined) scopeNames.push(scopeSpan.scope.name);
        for (const span of scopeSpan.spans ?? []) {
          if (span.name !== undefined) spanNames.push(span.name);
        }
      }
    }
  }

  return { scopeNames, spanNames };
}

interface OtlpSegment {
  readonly resourceSpans?: readonly {
    readonly scopeSpans?: readonly {
      readonly scope?: { readonly name?: string };
      readonly spans?: readonly { readonly name?: string }[];
    }[];
  }[];
}
