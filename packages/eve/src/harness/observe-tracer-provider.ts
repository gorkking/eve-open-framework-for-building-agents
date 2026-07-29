import {
  context,
  trace,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
} from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

/**
 * Resolves the processor to report to, at the moment a span is created.
 *
 * Late-bound because eve wraps tracer providers before it knows whether a
 * local trace writer will exist: interception is installed ahead of authored
 * `setup()` so no tracer escapes, while the processor is only built once the
 * dev worker's trace store settings are known. Returns `undefined` until then,
 * and spans created in that window are passed through untouched.
 */
export type SpanProcessorSource = () => SpanProcessor | undefined;

/**
 * Wraps a tracer provider so every span its tracers create is also reported to
 * `source()`.
 *
 * Tracers are wrapped per call rather than memoised: a tracer's identity is
 * `(name, version, options)` including `options.schemaUrl`, and a cache keyed
 * on anything less hands back a wrapper over the wrong delegate tracer.
 * Callers that care about tracer identity hold onto the tracer themselves.
 *
 * Forwarding only `getTracer` loses nothing a caller could reach: the API hands
 * out `ProxyTracerProvider`, whose own surface is `getTracer` and its delegate
 * accessors, so `forceFlush` and `shutdown` were never reachable through the
 * global. Whoever built the provider still holds it and can flush it directly.
 */
export function observeTracerProvider(
  delegate: TracerProvider,
  source: SpanProcessorSource,
): TracerProvider {
  return {
    getTracer(name: string, version?: string, options?: unknown): Tracer {
      return observeTracer(delegate.getTracer(name, version, options), source);
    },
  };
}

/**
 * `startActiveSpan` is reimplemented over `startSpan` rather than delegated so
 * that every span the tracer hands out passes through {@link observeSpan}; a
 * delegated call would create the span inside the wrapped tracer, out of reach.
 */
export function observeTracer(delegate: Tracer, source: SpanProcessorSource): Tracer {
  const tracer = {
    startSpan(name: string, options?: SpanOptions, parentContext?: Context): Span {
      const parent = parentContext ?? context.active();
      return observeSpan(delegate.startSpan(name, options, parent), source, parent);
    },

    startActiveSpan(name: string, ...rest: readonly unknown[]): unknown {
      const callback = rest.at(-1);
      if (typeof callback !== "function") {
        throw new TypeError("startActiveSpan requires a callback as its last argument.");
      }
      const [options, parentContext] = rest.slice(0, -1) as [SpanOptions?, Context?];
      const parent = parentContext ?? context.active();
      const span = tracer.startSpan(name, options, parent);
      return context.with(trace.setSpan(parent, span), () => callback(span));
    },
  };

  return tracer;
}

/**
 * Reports `span` to the processor without taking ownership of it.
 *
 * The span belongs to whoever created it, so it is proxied rather than
 * mutated: the OpenTelemetry API contracts nothing about a span being
 * extensible, and assigning over `end` would throw on a frozen or
 * accessor-backed implementation. Everything except `end` forwards to the real
 * span, so the provider's own processors and exporters see exactly the object
 * they always did.
 */
export function observeSpan(span: Span, source: SpanProcessorSource, parentContext: Context): Span {
  const processor = source();
  if (processor === undefined) return span;
  // A sampled-out span carries no attributes or timings, so there is nothing
  // for a processor to record and no trace for it to belong to.
  if (span.isRecording?.() === false) return span;
  // Nothing eve can do with a span whose `end` it cannot see: report neither
  // half rather than a start with no end.
  if (!isSubstitutable(span, "end")) return span;

  processor.onStart(span, parentContext);

  let ended = false;
  const end = (endTime?: number): void => {
    if (ended) return;
    ended = true;
    // The real `end` first: it stamps the end time and runs the observed
    // provider's own processors, so both sides see a finished span.
    span.end(endTime);
    processor.onEnd(span);
  };

  const forwarded = new Map<string | symbol, unknown>();
  const observed: Span = new Proxy(span, {
    get(target, property) {
      if (property === "end") return end;
      const cached = forwarded.get(property);
      if (cached !== undefined) return cached;
      // Read and call with the real span as the receiver: an implementation
      // backed by private fields throws when they are reached through a proxy.
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function" || !isSubstitutable(target, property)) return value;
      const method = (...args: readonly unknown[]): unknown => {
        const result = value.apply(target, args);
        // Chainable setters return the span itself; hand back the wrapper so a
        // chain ending in `.end()` still routes through it.
        return result === target ? observed : result;
      };
      forwarded.set(property, method);
      return method;
    },
  });

  return observed;
}

/**
 * Whether a proxy may return something other than `target[property]`.
 *
 * A proxy is forbidden from substituting a non-configurable, non-writable own
 * data property — reading one through the trap throws instead. Spans normally
 * carry their methods on a prototype, where the rule does not apply, so this
 * only ever declines for a frozen span.
 */
function isSubstitutable(target: object, property: string | symbol): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target, property);
  if (descriptor === undefined) return true;
  return descriptor.configurable === true || descriptor.writable === true;
}
