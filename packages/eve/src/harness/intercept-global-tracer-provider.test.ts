import { afterEach, describe, expect, it } from "vitest";

import type {
  Context,
  Span,
  SpanOptions,
  Tracer,
  TracerProvider,
} from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";
import type { DelegatingTracerProvider } from "#harness/delegating-tracer-provider.js";
import {
  attachInterceptedSpanProcessor,
  installGlobalTracerProviderInterception,
  releaseGlobalTracerProviderInterception,
} from "#harness/intercept-global-tracer-provider.js";

const API_REGISTRY_KEY = Symbol.for("opentelemetry.js.api.1");
const INTERCEPTION_STATE_KEY = Symbol.for("eve.harness-tracer-provider-interception");

interface ApiRegistry {
  trace?: TracerProvider;
  version?: string;
}

const container = globalThis as typeof globalThis & Record<symbol, unknown>;

afterEach(() => {
  releaseGlobalTracerProviderInterception();
  delete container[API_REGISTRY_KEY];
  delete container[INTERCEPTION_STATE_KEY];
});

describe("installGlobalTracerProviderInterception", () => {
  it("does not create the registry, so an author's own API version still registers", () => {
    expect(installGlobalTracerProviderInterception()).toBe(true);

    expect(container[API_REGISTRY_KEY]).toBeUndefined();

    // `registerGlobal` refuses a registry whose `version` is not its own, so the
    // object has to be the authored API's.
    const registry = registerApiRegistry("9.9.9");
    expect((container[API_REGISTRY_KEY] as ApiRegistry).version).toBe("9.9.9");
    expect(registry.trace).toBeUndefined();
  });

  // The reason interception exists: a tracer created during authored `setup()`
  // holds the concrete tracer, and no later delegate swap can reach it.
  it("observes tracers created before the trace writer is attached", () => {
    installGlobalTracerProviderInterception();
    const registry = registerApiRegistry("1.9.0");
    const events: string[] = [];

    registry.trace = createInnerProvider(events);
    const early = registry.trace.getTracer("authored");

    const { processor, started } = createRecordingProcessor();
    expect(attachInterceptedSpanProcessor(processor)).toBe(true);

    early.startSpan("authored.work").end();

    expect(started).toEqual(["authored.work"]);
    expect(events).toEqual(["inner-end:authored.work"]);
  });

  // Interception is also where a run's internal spans stop existing: the
  // author's provider never gets asked for them, so their exporter never sees
  // them.
  it("suppresses the Workflow SDK's tracer on the provider it hands back", () => {
    installGlobalTracerProviderInterception();
    const registry = registerApiRegistry("1.9.0");
    const events: string[] = [];

    registry.trace = createInnerProvider(events);
    const { processor, started } = createRecordingProcessor();
    attachInterceptedSpanProcessor(processor);

    registry.trace.getTracer("workflow").startSpan("step.execute").end();
    registry.trace.getTracer("authored").startSpan("authored.work").end();

    expect(events).toEqual(["inner-end:authored.work"]);
    expect(started).toEqual(["authored.work"]);
  });

  // `setGlobalTracerProvider` registers its proxy first and sets the real
  // provider as the delegate only after, so a tracer taken in between is a
  // `ProxyTracer` that resolves lazily. Hooking the delegate is what reaches it;
  // wrapping the proxy would not.
  it("observes tracers taken from a proxy before its delegate is set", () => {
    installGlobalTracerProviderInterception();
    const registry = registerApiRegistry("1.9.0");
    const events: string[] = [];
    const proxy = createProxyProvider();

    registry.trace = proxy;
    const early = registry.trace.getTracer("authored");
    proxy.setDelegate(createInnerProvider(events));

    const { processor, started } = createRecordingProcessor();
    expect(attachInterceptedSpanProcessor(processor)).toBe(true);

    early.startSpan("authored.work").end();

    expect(started).toEqual(["authored.work"]);
    expect(events).toEqual(["inner-end:authored.work"]);
  });

  it("observes a proxy that already had a delegate", () => {
    const events: string[] = [];
    const proxy = createProxyProvider();
    proxy.setDelegate(createInnerProvider(events));

    installGlobalTracerProviderInterception();
    const registry = registerApiRegistry("1.9.0");
    registry.trace = proxy;

    const { processor, started } = createRecordingProcessor();
    expect(attachInterceptedSpanProcessor(processor)).toBe(true);

    proxy.getTracer("authored").startSpan("authored.work").end();

    expect(started).toEqual(["authored.work"]);
  });

  // `registerGlobal` assigns the registry slot on every registration it makes —
  // context and propagation as well as trace — always with the same object.
  // Re-intercepting it would wrap the provider a second time and report every
  // span twice.
  it("reports each span once when the registry object is reassigned", () => {
    installGlobalTracerProviderInterception();
    const registry = registerApiRegistry("1.9.0");
    const events: string[] = [];

    registry.trace = createInnerProvider(events);
    // What `registerGlobal` does when the author also registers a context
    // manager and a propagator: same object, back into the same slot.
    container[API_REGISTRY_KEY] = registry;
    container[API_REGISTRY_KEY] = registry;

    const { processor, started } = createRecordingProcessor();
    expect(attachInterceptedSpanProcessor(processor)).toBe(true);

    registry.trace.getTracer("authored").startSpan("authored.work").end();

    expect(started).toEqual(["authored.work"]);
    expect(events).toEqual(["inner-end:authored.work"]);
  });

  it("is idempotent", () => {
    expect(installGlobalTracerProviderInterception()).toBe(true);
    expect(installGlobalTracerProviderInterception()).toBe(true);
  });
});

describe("attachInterceptedSpanProcessor", () => {
  it("declines when interception was never installed", () => {
    expect(attachInterceptedSpanProcessor(createRecordingProcessor().processor)).toBe(false);
  });

  // An authored `setup` that configures a non-OTel backend registers no
  // provider. eve has to register one of its own, so the slot is handed back
  // rather than left wrapping nothing.
  it("declines and releases the slot when nothing registered a provider", () => {
    installGlobalTracerProviderInterception();
    const registry = registerApiRegistry("1.9.0");

    expect(attachInterceptedSpanProcessor(createRecordingProcessor().processor)).toBe(false);

    const provider = createInnerProvider([]);
    registry.trace = provider;
    expect(registry.trace).toBe(provider);
  });
});

describe("releaseGlobalTracerProviderInterception", () => {
  it("restores the provider as it was registered", () => {
    installGlobalTracerProviderInterception();
    const registry = registerApiRegistry("1.9.0");
    const provider = createInnerProvider([]);

    registry.trace = provider;
    expect(registry.trace).not.toBe(provider);

    releaseGlobalTracerProviderInterception();

    expect(registry.trace).toBe(provider);
    expect(Object.getOwnPropertyDescriptor(registry, "trace")?.get).toBeUndefined();
  });

  // eve declines rather than degrading the authored path, so a released proxy
  // has to be left delegating to exactly what the author registered.
  it("restores a proxy's delegate as the author set it", () => {
    installGlobalTracerProviderInterception();
    const registry = registerApiRegistry("1.9.0");
    const events: string[] = [];
    const proxy = createProxyProvider();
    const delegate = createInnerProvider(events);

    registry.trace = proxy;
    proxy.setDelegate(delegate);
    expect(proxy.getDelegate()).not.toBe(delegate);

    releaseGlobalTracerProviderInterception();

    expect(proxy.getDelegate()).toBe(delegate);
    // The proxy itself goes back into the slot, not the delegate eve unwrapped
    // out of it, so `trace.getTracerProvider()` still answers what it did.
    expect(registry.trace).toBe(proxy);
    proxy.getTracer("authored").startSpan("authored.work").end();
    expect(events).toEqual(["inner-end:authored.work"]);
  });

  it("is safe to call without an installation", () => {
    expect(() => releaseGlobalTracerProviderInterception()).not.toThrow();
  });
});

/**
 * `ProxyTracerProvider` as the authored API copy defines it: registered before
 * its delegate exists, and handing out tracers that resolve through whatever
 * delegate is set by the time a span is started.
 */
function createProxyProvider(): DelegatingTracerProvider {
  let delegate: TracerProvider | undefined;
  const noopTracer: Tracer = { startSpan: () => ({}) as Span };
  const proxy: DelegatingTracerProvider = {
    getDelegate: () => delegate ?? { getTracer: () => noopTracer },
    getDelegateTracer: (name: string, version?: string, options?: unknown) =>
      delegate?.getTracer(name, version, options),
    getTracer: (name: string, version?: string, options?: unknown) => ({
      startSpan: (spanName: string, spanOptions?: SpanOptions, parentContext?: Context) =>
        (delegate?.getTracer(name, version, options) ?? noopTracer).startSpan(
          spanName,
          spanOptions,
          parentContext,
        ),
    }),
    setDelegate: (next: TracerProvider) => {
      delegate = next;
    },
  };
  return proxy;
}

/** What `registerGlobal` does on first use: create the registry, or reuse it. */
function registerApiRegistry(version: string): ApiRegistry {
  const registry: ApiRegistry = { version };
  container[API_REGISTRY_KEY] = registry;
  return container[API_REGISTRY_KEY] as ApiRegistry;
}

function createRecordingProcessor(): { processor: SpanProcessor; started: string[] } {
  const started: string[] = [];
  return {
    processor: {
      forceFlush: async () => {},
      onEnd: () => {},
      onStart: (span: unknown) => void started.push((span as { name: string }).name),
      shutdown: async () => {},
    },
    started,
  };
}

function createInnerProvider(events: string[]): TracerProvider {
  return {
    getTracer(): Tracer {
      return {
        startSpan(name: string, _options?: SpanOptions, _parentContext?: Context): Span {
          const span: Span & { name: string } = {
            addEvent: () => span,
            end: () => void events.push(`inner-end:${name}`),
            isRecording: () => true,
            name,
            recordException: () => {},
            setAttribute: () => span,
            setStatus: () => span,
            spanContext: () => ({ spanId: "b".repeat(16), traceFlags: 1, traceId: "a".repeat(32) }),
          };
          return span;
        },
      };
    },
  };
}
