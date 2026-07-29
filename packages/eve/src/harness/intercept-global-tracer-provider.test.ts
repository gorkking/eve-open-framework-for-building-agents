import { afterEach, describe, expect, it } from "vitest";

import type {
  Context,
  Span,
  SpanOptions,
  Tracer,
  TracerProvider,
} from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";
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

  it("is safe to call without an installation", () => {
    expect(() => releaseGlobalTracerProviderInterception()).not.toThrow();
  });
});

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
