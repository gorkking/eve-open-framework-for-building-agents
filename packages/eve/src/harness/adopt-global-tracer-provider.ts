import {
  context,
  ProxyTracerProvider,
  trace,
  type Context,
  type Span,
  type SpanOptions,
  type Tracer,
  type TracerProvider,
} from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

/**
 * The `ProxyTracerProvider` shape `setGlobalTracerProvider` registers.
 *
 * Matched structurally, not with `instanceof`: authored `instrumentation.ts`
 * resolves `@opentelemetry/api` from the agent's own dependencies while eve
 * uses its vendored copy, so the two hold different classes. Only the global
 * registry itself is shared, through `globalThis`.
 */
interface AdoptableTracerProvider extends TracerProvider {
  getDelegate(): TracerProvider;
  setDelegate(delegate: TracerProvider): void;
}

/**
 * Routes an already-registered global tracer provider through `processor`.
 *
 * `eve dev` installs its local trace writer after authored
 * `instrumentation.ts` has run, so a provider the agent author registered is
 * usually already global. A second `registerOTel` call would lose to it, and
 * `BasicTracerProvider` has no public way to add a span processor after
 * construction, so eve wraps the provider instead of competing with it: the
 * author's exporter keeps every span it receives today, and eve additionally
 * sees agent, AI SDK, and user spans.
 *
 * Returns `false` when no provider is registered, and the caller should
 * register its own instead.
 */
export function adoptGlobalTracerProvider(processor: SpanProcessor): boolean {
  const globalProvider = trace.getTracerProvider();
  if (!isAdoptable(globalProvider)) return false;

  const delegate = globalProvider.getDelegate();
  if (delegate === unregisteredDelegate()) return false;

  globalProvider.setDelegate(observeTracerProvider(delegate, processor));
  return true;
}

function isAdoptable(provider: TracerProvider): provider is AdoptableTracerProvider {
  const candidate = provider as Partial<AdoptableTracerProvider>;
  return typeof candidate.getDelegate === "function" && typeof candidate.setDelegate === "function";
}

/**
 * What a proxy delegates to before anyone registers: the API's shared no-op
 * provider.
 *
 * The proxy shape alone cannot answer "did an author register a provider?".
 * `trace.getTracerProvider()` returns a proxy either way — with nothing
 * registered it hands back the API's own standby instance rather than a no-op
 * — so eve compares delegates instead. A fresh proxy's delegate is that
 * singleton, and any delegate that differs from it came from a real
 * registration.
 */
function unregisteredDelegate(): TracerProvider {
  return new ProxyTracerProvider().getDelegate();
}

function observeTracerProvider(delegate: TracerProvider, processor: SpanProcessor): TracerProvider {
  const tracers = new Map<string, Tracer>();

  return {
    getTracer(name: string, version?: string, options?: unknown): Tracer {
      const key = `${name}@${version ?? ""}`;
      const cached = tracers.get(key);
      if (cached !== undefined) return cached;

      const observed = observeTracer(delegate.getTracer(name, version, options), processor);
      tracers.set(key, observed);
      return observed;
    },
  };
}

/**
 * `startActiveSpan` is reimplemented over `startSpan` rather than delegated so
 * that every span the tracer hands out passes through `observeSpan`; a
 * delegated call would create the span inside the wrapped tracer, out of reach.
 */
function observeTracer(delegate: Tracer, processor: SpanProcessor): Tracer {
  const tracer = {
    startSpan(name: string, options?: SpanOptions, parentContext?: Context): Span {
      const parent = parentContext ?? context.active();
      return observeSpan(delegate.startSpan(name, options, parent), processor, parent);
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

function observeSpan(span: Span, processor: SpanProcessor, parentContext: Context): Span {
  // A sampled-out span carries no attributes or timings, so there is nothing
  // for a processor to record and no trace for it to belong to.
  if (span.isRecording?.() === false) return span;

  processor.onStart(span, parentContext);

  const end = span.end.bind(span);
  let ended = false;
  span.end = (endTime?: number): void => {
    if (ended) return;
    ended = true;
    // The real `end` first: it stamps the end time and runs the adopted
    // provider's own processors, so both sides observe a finished span.
    end(endTime);
    processor.onEnd(span);
  };

  return span;
}
