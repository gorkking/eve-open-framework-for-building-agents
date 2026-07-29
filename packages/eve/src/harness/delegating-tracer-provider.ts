import type { TracerProvider } from "#compiled/@opentelemetry/api/index.js";

/**
 * The `ProxyTracerProvider` surface, duck-typed.
 *
 * `setGlobalTracerProvider` registers this proxy rather than the provider
 * handed to it, so it is the shape eve meets at the global slot. It cannot be
 * recognized with `instanceof`: an authored `instrumentation.ts` resolves
 * `@opentelemetry/api` from the agent's own dependencies, so its class is a
 * different object than the one in eve's vendored copy.
 */
export interface DelegatingTracerProvider extends TracerProvider {
  getDelegate: () => TracerProvider;
  getDelegateTracer: (name: string, version?: string, options?: unknown) => unknown;
  setDelegate: (delegate: TracerProvider) => void;
}

/**
 * Whether `provider` resolves its tracers through a delegate that can be
 * replaced.
 *
 * @internal — not part of the public API.
 */
export function isDelegatingTracerProvider(
  provider: TracerProvider,
): provider is DelegatingTracerProvider {
  const candidate = provider as Partial<DelegatingTracerProvider>;
  return (
    typeof candidate.getDelegate === "function" &&
    typeof candidate.getDelegateTracer === "function" &&
    typeof candidate.setDelegate === "function"
  );
}

/**
 * Whether a delegate has been set on `provider`.
 *
 * `getDelegate()` cannot answer this: with nothing set it returns the API's
 * no-op provider, and that singleton belongs to whichever copy of
 * `@opentelemetry/api` created the proxy, so eve has no object to compare it
 * against. `getDelegateTracer` returns `undefined` in exactly that case.
 *
 * @internal — not part of the public API.
 */
export function hasTracerProviderDelegate(provider: DelegatingTracerProvider): boolean {
  return provider.getDelegateTracer("eve.delegate-probe") !== undefined;
}
