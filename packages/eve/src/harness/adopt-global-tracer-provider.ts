import {
  ProxyTracerProvider,
  trace,
  type TracerProvider,
} from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import { observeTracerProvider } from "#harness/observe-tracer-provider.js";

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
 * The fallback for when `intercept-global-tracer-provider.ts` could not claim
 * the global slot. It reaches spans created from this point on, but not from
 * tracers the provider had already handed out — swapping a proxy's delegate
 * cannot reach a concrete tracer somebody is holding. Interception is the path
 * that has no such gap.
 *
 * Returns `false` when no provider is registered, and the caller should
 * register its own instead.
 *
 * @internal — not part of the public API.
 */
export function adoptGlobalTracerProvider(processor: SpanProcessor): boolean {
  const globalProvider = trace.getTracerProvider();
  if (!isAdoptable(globalProvider)) return false;

  const delegate = globalProvider.getDelegate();
  if (delegate === unregisteredDelegate()) return false;

  globalProvider.setDelegate(observeTracerProvider(delegate, () => processor));
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
