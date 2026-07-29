import {
  INVALID_SPAN_CONTEXT,
  context,
  trace,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
} from "#compiled/@opentelemetry/api/index.js";

import { WORKFLOW_INSTRUMENTATION_SCOPE } from "#harness/workflow-instrumentation-scope.js";

/**
 * Wraps a tracer provider so the Workflow SDK's tracer creates no spans.
 *
 * A durable run's internals — `step.execute`, `step.hydrate`, `queue.publish` —
 * describe how eve executes a turn rather than what the agent did, and they land
 * in the agent's own trace because a turn runs inside a step. eve keeps them out
 * of `.eve/traces/v1` by filtering at its writer, but a writer-side filter can
 * do nothing for an authored `instrumentation.ts`: the author's provider creates
 * the span, so the only way its exporter never receives one is for the span not
 * to exist. Scope is known at `getTracer` time, which is before it does.
 *
 * `eve dev` only, alongside the interception it composes with; production
 * registers no wrapper and is unchanged.
 */
export function suppressWorkflowInstrumentation(delegate: TracerProvider): TracerProvider {
  return {
    getTracer(name: string, version?: string, options?: unknown): Tracer {
      if (name === WORKFLOW_INSTRUMENTATION_SCOPE) return createSuppressedTracer();
      return delegate.getTracer(name, version, options);
    },
  };
}

/**
 * A tracer whose spans record nothing and reach no exporter.
 *
 * Each span carries its parent's span context instead of an empty one, so a span
 * started under a suppressed span becomes a child of the nearest ancestor that
 * was not suppressed and inherits the sampling decision already made upstream.
 * Suppressed spans drop out of the tree rather than detaching everything below
 * them.
 */
export function createSuppressedTracer(): Tracer {
  const tracer = {
    startSpan(_name: string, options?: SpanOptions, parentContext?: Context): Span {
      if (options?.root === true) return trace.wrapSpanContext(INVALID_SPAN_CONTEXT);
      const parent = parentContext ?? context.active();
      return trace.wrapSpanContext(trace.getSpanContext(parent) ?? INVALID_SPAN_CONTEXT);
    },

    startActiveSpan(name: string, ...rest: readonly unknown[]): unknown {
      const callback = rest.at(-1);
      if (typeof callback !== "function") {
        throw new TypeError("startActiveSpan requires a callback as its last argument.");
      }
      const [options, parentContext] = rest.slice(0, -1) as [SpanOptions?, Context?];
      const parent = parentContext ?? context.active();
      const span = tracer.startSpan(name, options, parent);
      // Activated even though it records nothing: code inside the callback is
      // free to read the active span, and the context it resolves through has to
      // be the one the suppressed span carries.
      return context.with(trace.setSpan(parent, span), () => callback(span));
    },
  };

  return tracer;
}
