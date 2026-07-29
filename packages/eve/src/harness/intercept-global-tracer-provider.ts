import type { TracerProvider } from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import { observeTracerProvider } from "#harness/observe-tracer-provider.js";

/**
 * The slot `@opentelemetry/api` stores its global tracer provider in.
 *
 * Every copy of the API in the process shares this one object through
 * `globalThis`, keyed by the API's major version — the only thing an authored
 * `instrumentation.ts` and eve's vendored copy have in common. `1` is the major
 * of the vendored API; a registration made by an API with a different major is
 * unreadable by eve either way, so there is nothing to intercept there.
 */
const API_REGISTRY_KEY = Symbol.for("opentelemetry.js.api.1");

/**
 * Held on `globalThis` because eve's interception plugin and its trace-writer
 * plugin can resolve to two module instances, and installing in one while
 * attaching in the other would silently leave the writer unwired. Same reason
 * as `instrumentation-config.ts`.
 */
const INTERCEPTION_STATE_KEY = Symbol.for("eve.harness-tracer-provider-interception");

interface ApiRegistry {
  trace?: TracerProvider;
}

interface InterceptionState {
  installed: boolean;
  /** The provider as registered, before eve wrapped it. */
  origin: TracerProvider | undefined;
  processor: SpanProcessor | undefined;
}

type GlobalSlots = Record<symbol, unknown>;

const container = globalThis as typeof globalThis & GlobalSlots;

function state(): InterceptionState {
  const existing = container[INTERCEPTION_STATE_KEY];
  if (existing !== undefined) return existing as InterceptionState;
  const created: InterceptionState = { installed: false, origin: undefined, processor: undefined };
  container[INTERCEPTION_STATE_KEY] = created;
  return created;
}

/**
 * Claims the global tracer-provider slot so eve observes every tracer, however
 * early it is created.
 *
 * Must run *before* authored `setup()`. Adopting a provider after the fact is
 * not equivalent: `ProxyTracerProvider.getTracer` hands out the delegate's
 * concrete tracer once a delegate exists, so a tracer created during `setup()`
 * — by an auto-instrumentation the author enabled, say — keeps a direct
 * reference and no later delegate swap can reach it.
 *
 * eve deliberately does not create the registry object. It carries the version
 * of whichever API instance registers first, and `registerGlobal` refuses a
 * registration whose version does not match, so a registry created by eve's
 * vendored copy would break an author on any other patch release. Instead the
 * `globalThis` slot itself is intercepted and the author's own object is
 * decorated when it arrives.
 *
 * Returns `false` when the slot cannot be claimed, leaving global state
 * untouched; the caller falls back to adopting whatever registers.
 *
 * @internal — not part of the public API.
 */
export function installGlobalTracerProviderInterception(): boolean {
  const current = state();
  if (current.installed) return true;
  try {
    current.installed = claimRegistrySlot();
  } catch {
    current.installed = false;
  }
  return current.installed;
}

/**
 * Routes the spans of every intercepted tracer to `processor`.
 *
 * Returns `false` when interception is not installed, or when nothing
 * registered a provider through it — an authored `setup()` that configures a
 * non-OTel backend, for instance. In that case the slot is released first so
 * the caller can register its own provider without spans being reported twice.
 *
 * @internal — not part of the public API.
 */
export function attachInterceptedSpanProcessor(processor: SpanProcessor): boolean {
  const current = state();
  if (!current.installed) return false;
  if (current.origin === undefined) {
    releaseGlobalTracerProviderInterception();
    return false;
  }
  current.processor = processor;
  return true;
}

/**
 * Restores the global slot to a plain property holding the provider as
 * registered.
 *
 * @internal — not part of the public API.
 */
export function releaseGlobalTracerProviderInterception(): void {
  const current = state();
  if (!current.installed) return;
  current.installed = false;
  current.processor = undefined;
  const registry = container[API_REGISTRY_KEY] as ApiRegistry | undefined;
  const origin = current.origin;
  current.origin = undefined;
  try {
    delete container[API_REGISTRY_KEY];
    if (registry === undefined) return;
    delete registry.trace;
    if (origin !== undefined) registry.trace = origin;
    container[API_REGISTRY_KEY] = registry;
  } catch {
    // Left uninstalled: the wrappers already handed out report to nothing once
    // the processor is cleared, so they degrade to pass-through.
  }
}

function claimRegistrySlot(): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(container, API_REGISTRY_KEY);
  if (descriptor?.configurable === false) return false;

  const existing = container[API_REGISTRY_KEY] as ApiRegistry | undefined;
  if (existing !== undefined) return interceptTraceSlot(existing);

  let registry: ApiRegistry | undefined;
  Object.defineProperty(container, API_REGISTRY_KEY, {
    configurable: true,
    get: () => registry,
    set: (value: ApiRegistry | undefined) => {
      registry = value;
      if (value !== undefined) interceptTraceSlot(value);
    },
  });
  return true;
}

function interceptTraceSlot(registry: ApiRegistry): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(registry, "trace");
  if (descriptor?.configurable === false) return false;

  const current = state();
  let observed = observe(registry.trace);
  delete registry.trace;
  Object.defineProperty(registry, "trace", {
    configurable: true,
    enumerable: true,
    get: () => observed,
    set: (provider: TracerProvider | undefined) => {
      observed = observe(provider);
    },
  });
  return true;

  function observe(provider: TracerProvider | undefined): TracerProvider | undefined {
    current.origin = provider;
    if (provider === undefined) return undefined;
    return observeTracerProvider(provider, () => state().processor);
  }
}
