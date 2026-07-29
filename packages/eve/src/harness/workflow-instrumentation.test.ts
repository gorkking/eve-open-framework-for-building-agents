import { describe, expect, it } from "vitest";

import {
  ROOT_CONTEXT,
  trace,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
} from "#compiled/@opentelemetry/api/index.js";
import { suppressWorkflowInstrumentation } from "#harness/workflow-instrumentation.js";

const PARENT_SPAN_CONTEXT = { spanId: "b".repeat(16), traceFlags: 1, traceId: "a".repeat(32) };

describe("suppressWorkflowInstrumentation", () => {
  it("creates no span for the Workflow SDK's tracer", () => {
    const started: string[] = [];
    const provider = suppressWorkflowInstrumentation(createProvider(started));

    const span = provider.getTracer("workflow").startSpan("step.execute");
    span.end();

    expect(started).toEqual([]);
    expect(span.isRecording?.()).toBe(false);
  });

  it("passes every other tracer through untouched", () => {
    const started: string[] = [];
    const inner = createProvider(started);
    const provider = suppressWorkflowInstrumentation(inner);

    provider.getTracer("authored").startSpan("authored.work").end();
    provider.getTracer("eve.agent", "1.2.3").startSpan("agent.session").end();

    expect(started).toEqual(["authored.work", "agent.session"]);
  });

  // A span the SDK starts under a suppressed one has to reach the agent's span,
  // not fall out of the trace: `agent.step` stays the parent of the model call
  // inside it even when the step ran inside a durable step.
  it("hands a suppressed span its parent's context so descendants reparent", () => {
    const provider = suppressWorkflowInstrumentation(createProvider([]));
    const parent = trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(PARENT_SPAN_CONTEXT));

    const span = provider.getTracer("workflow").startSpan("step.execute", {}, parent);

    expect(span.spanContext()).toEqual(PARENT_SPAN_CONTEXT);
  });

  it("gives a root span no context to inherit", () => {
    const provider = suppressWorkflowInstrumentation(createProvider([]));
    const parent = trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext(PARENT_SPAN_CONTEXT));

    const span = provider
      .getTracer("workflow")
      .startSpan("workflow.route.flow", { root: true }, parent);

    expect(span.spanContext().traceId).toBe("0".repeat(32));
  });

  // `@workflow/core` wraps its steps with `startActiveSpan` and depends on the
  // callback's return value, so suppression has to implement it rather than
  // leave the tracer without it.
  it("runs a suppressed startActiveSpan callback and returns its result", () => {
    const started: string[] = [];
    const provider = suppressWorkflowInstrumentation(createProvider(started));
    const tracer = provider.getTracer("workflow") as Tracer & {
      startActiveSpan: (name: string, callback: (span: Span) => unknown) => unknown;
    };

    const result = tracer.startActiveSpan("step.execute", (span) => {
      span.end();
      return "done";
    });

    expect(result).toBe("done");
    expect(started).toEqual([]);
  });

  it("rejects a startActiveSpan call with no callback", () => {
    const provider = suppressWorkflowInstrumentation(createProvider([]));
    const tracer = provider.getTracer("workflow") as Tracer & {
      startActiveSpan: (name: string) => unknown;
    };

    expect(() => tracer.startActiveSpan("step.execute")).toThrow(TypeError);
  });
});

function createProvider(started: string[]): TracerProvider {
  return {
    getTracer(): Tracer {
      return {
        startSpan(name: string, _options?: SpanOptions, _parentContext?: Context): Span {
          started.push(name);
          return trace.wrapSpanContext(PARENT_SPAN_CONTEXT);
        },
      };
    },
  };
}
