import { describe, expect, it } from "vitest";

import {
  ProxyTracerProvider,
  type Span,
  type Tracer,
  type TracerProvider,
} from "#compiled/@opentelemetry/api/index.js";
import {
  hasTracerProviderDelegate,
  isDelegatingTracerProvider,
  type DelegatingTracerProvider,
} from "#harness/delegating-tracer-provider.js";

describe("isDelegatingTracerProvider", () => {
  it("recognizes the real proxy provider", () => {
    expect(isDelegatingTracerProvider(new ProxyTracerProvider())).toBe(true);
  });

  // The case `instanceof` cannot answer: an authored `instrumentation.ts`
  // resolves its own copy of `@opentelemetry/api`, so the proxy eve meets at the
  // global slot is an instance of a class eve has never seen.
  it("recognizes a proxy from a foreign copy of the API", () => {
    expect(isDelegatingTracerProvider(createForeignProxy())).toBe(true);
  });

  it("rejects a plain provider", () => {
    expect(isDelegatingTracerProvider({ getTracer: () => createTracer() })).toBe(false);
  });
});

describe("hasTracerProviderDelegate", () => {
  it("is false for a proxy nobody has claimed", () => {
    expect(hasTracerProviderDelegate(new ProxyTracerProvider())).toBe(false);
    expect(hasTracerProviderDelegate(createForeignProxy())).toBe(false);
  });

  it("is true once a delegate is set", () => {
    const proxy = new ProxyTracerProvider();
    proxy.setDelegate({ getTracer: () => createTracer() });

    expect(hasTracerProviderDelegate(proxy)).toBe(true);
  });

  // The probe must not leave a tracer behind in the delegate's cache under a
  // name the author would later use, so it asks for one of eve's own.
  it("probes under an eve-namespaced tracer name", () => {
    const asked: string[] = [];
    const proxy = createForeignProxy();
    proxy.setDelegate({
      getTracer: (name: string) => {
        asked.push(name);
        return createTracer();
      },
    });

    expect(hasTracerProviderDelegate(proxy)).toBe(true);
    expect(asked.every((name) => name.startsWith("eve."))).toBe(true);
  });
});

/**
 * `ProxyTracerProvider` as another copy of the API would define it: same shape,
 * unrelated class, and its own no-op provider that eve has no reference to.
 */
function createForeignProxy(): DelegatingTracerProvider {
  let delegate: TracerProvider | undefined;
  const noop: TracerProvider = { getTracer: () => createTracer() };
  return {
    getDelegate: () => delegate ?? noop,
    getDelegateTracer: (name: string, version?: string, options?: unknown) =>
      delegate?.getTracer(name, version, options),
    getTracer: (name: string, version?: string, options?: unknown) =>
      delegate?.getTracer(name, version, options) ?? noop.getTracer(name),
    setDelegate: (next: TracerProvider) => {
      delegate = next;
    },
  };
}

function createTracer(): Tracer {
  return { startSpan: () => ({}) as Span };
}
