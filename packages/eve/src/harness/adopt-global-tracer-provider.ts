import { trace } from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import {
  hasTracerProviderDelegate,
  isDelegatingTracerProvider,
} from "#harness/delegating-tracer-provider.js";
import { observeTracerProvider } from "#harness/observe-tracer-provider.js";

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
  // Returns a proxy whether or not anything registered — with nothing
  // registered it is the API's own standby instance — so the delegate, not the
  // provider, is what says whether there is anything to adopt.
  const globalProvider = trace.getTracerProvider();
  if (!isDelegatingTracerProvider(globalProvider)) return false;
  if (!hasTracerProviderDelegate(globalProvider)) return false;

  globalProvider.setDelegate(observeTracerProvider(globalProvider.getDelegate(), () => processor));
  return true;
}
