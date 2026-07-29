import type { TracerProvider } from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import {
  hasTracerProviderDelegate,
  isDelegatingTracerProvider,
  type DelegatingTracerProvider,
} from "#harness/delegating-tracer-provider.js";
import { observeTracerProvider } from "#harness/observe-tracer-provider.js";

// Reaching into another library's global registry is the price of leaving the
// authored API alone: `instrumentation.ts` calls `registerOTel` itself, and a
// single-owner global is the only thing eve can hook. `eve dev` only. When
// `research/provider-neutral-local-observability.md` hands `setup` an eve-owned
// registration instead, this module and its two plugins go away.

/**
 * The slot `@opentelemetry/api` stores its global registry in.
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
  /** Proxy providers already hooked, so a second visit is a no-op. */
  hooked: Set<DelegatingTracerProvider>;
  installed: boolean;
  processor: SpanProcessor | undefined;
  /** The provider as registered, before eve wrapped it. */
  provider: TracerProvider | undefined;
  /** Undo steps, newest last, run in reverse by the release. */
  undo: Array<() => void>;
}

type GlobalSlots = Record<symbol, unknown>;

const container = globalThis as typeof globalThis & GlobalSlots;

function state(): InterceptionState {
  const existing = container[INTERCEPTION_STATE_KEY];
  if (existing !== undefined) return existing as InterceptionState;
  const created: InterceptionState = {
    hooked: new Set(),
    installed: false,
    processor: undefined,
    provider: undefined,
    undo: [],
  };
  container[INTERCEPTION_STATE_KEY] = created;
  return created;
}

function processorSource(): SpanProcessor | undefined {
  return state().processor;
}

/**
 * Claims the global tracer-provider slot so eve observes every tracer, however
 * early it is created.
 *
 * Must run *before* anything registers a provider. Wrapping one after the fact
 * is not equivalent: `ProxyTracerProvider.getTracer` hands out the delegate's
 * concrete tracer once a delegate exists, so a tracer created during authored
 * `setup()` — by an auto-instrumentation the author enabled, say — keeps a
 * direct reference that no later swap can reach.
 *
 * eve deliberately does not create the registry object. It carries the version
 * of whichever API instance registers first, and `registerGlobal` refuses a
 * registration whose version does not match, so a registry created by eve's
 * vendored copy would break an author on any other patch release. Instead the
 * `globalThis` slot itself is intercepted and the author's own object is
 * decorated when it arrives.
 *
 * Returns `false` when the slot cannot be claimed, leaving global state
 * untouched. There is no second way in: a provider already handed out concrete
 * tracers, and swapping it after the fact would miss them.
 *
 * @internal — not part of the public API.
 */
export function installGlobalTracerProviderInterception(): boolean {
  const current = state();
  if (current.installed) return true;
  try {
    current.installed = claimRegistrySlot(current);
  } catch {
    current.installed = false;
  }
  if (!current.installed) current.undo.length = 0;
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
  if (current.provider === undefined) {
    releaseGlobalTracerProviderInterception();
    return false;
  }
  current.processor = processor;
  return true;
}

/**
 * Undoes every intervention, leaving the provider reachable exactly as it was
 * registered.
 *
 * @internal — not part of the public API.
 */
export function releaseGlobalTracerProviderInterception(): void {
  const current = state();
  if (!current.installed) return;
  current.installed = false;
  current.processor = undefined;
  current.hooked.clear();
  const undo = current.undo.splice(0, current.undo.length).reverse();
  for (const step of undo) {
    try {
      step();
    } catch {
      // Left uninstalled: with the processor cleared, any wrapper still in
      // place reports to nothing and degrades to a pass-through.
    }
  }
  current.provider = undefined;
}

function claimRegistrySlot(current: InterceptionState): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(container, API_REGISTRY_KEY);
  if (descriptor?.configurable === false) return false;

  const existing = container[API_REGISTRY_KEY] as ApiRegistry | undefined;
  if (existing !== undefined) return interceptTraceSlot(current, existing);

  let registry: ApiRegistry | undefined;
  Object.defineProperty(container, API_REGISTRY_KEY, {
    configurable: true,
    get: () => registry,
    // `registerGlobal` reassigns this slot on every registration it makes —
    // context, propagation, and metrics as well as trace — always with the
    // same object once one exists. Only a new object is worth intercepting;
    // repeating the work on the same one would wrap the provider again and
    // report every span twice.
    set: (value: ApiRegistry | undefined) => {
      if (value === registry) return;
      registry = value;
      if (value !== undefined) interceptTraceSlot(current, value);
    },
  });
  current.undo.push(() => {
    delete container[API_REGISTRY_KEY];
    if (registry !== undefined) container[API_REGISTRY_KEY] = registry;
  });
  return true;
}

function interceptTraceSlot(current: InterceptionState, registry: ApiRegistry): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(registry, "trace");
  if (descriptor?.configurable === false) return false;

  let registered = registry.trace;
  let stored = intercept(current, registered);
  delete registry.trace;
  Object.defineProperty(registry, "trace", {
    configurable: true,
    enumerable: true,
    get: () => stored,
    set: (provider: TracerProvider | undefined) => {
      registered = provider;
      stored = intercept(current, provider);
    },
  });
  current.undo.push(() => {
    delete registry.trace;
    // What the author assigned, which is not what eve stored: a proxy goes back
    // as the proxy, a concrete provider goes back unwrapped.
    if (registered !== undefined) registry.trace = registered;
  });
  return true;
}

/**
 * What the registry holds once eve has had its say.
 *
 * A proxy provider is stored untouched and hooked at its delegate instead.
 * `setGlobalTracerProvider` registers the proxy first and only then sets the
 * real provider as its delegate, and a tracer taken before registration
 * resolves through that same delegate — so hooking the delegate catches both,
 * where wrapping the proxy would catch neither.
 */
function intercept(
  current: InterceptionState,
  provider: TracerProvider | undefined,
): TracerProvider | undefined {
  if (provider === undefined) return undefined;
  if (isDelegatingTracerProvider(provider)) {
    hookDelegate(current, provider);
    return provider;
  }
  current.provider = provider;
  return observeTracerProvider(provider, processorSource);
}

function hookDelegate(current: InterceptionState, proxy: DelegatingTracerProvider): void {
  if (current.hooked.has(proxy)) return;
  const descriptor = Object.getOwnPropertyDescriptor(proxy, "setDelegate");
  if (descriptor !== undefined && descriptor.configurable !== true) return;
  current.hooked.add(proxy);

  const original = proxy.setDelegate;
  // Tracked per proxy rather than read back off the shared state, which holds
  // whichever provider registered last and may belong to another proxy.
  let delegated: TracerProvider | undefined;
  const observe = (delegate: TracerProvider): void => {
    current.provider = delegate;
    delegated = delegate;
    original.call(proxy, observeTracerProvider(delegate, processorSource));
  };
  Object.defineProperty(proxy, "setDelegate", {
    configurable: true,
    value: observe,
    writable: true,
  });
  current.undo.push(() => {
    // `setDelegate` normally lives on the prototype, where deleting the override
    // is enough; a proxy carrying it as an own property needs that property put
    // back, or the release would leave the provider with no way to be set.
    if (descriptor === undefined) delete (proxy as Partial<DelegatingTracerProvider>).setDelegate;
    else Object.defineProperty(proxy, "setDelegate", descriptor);
    if (delegated !== undefined) proxy.setDelegate(delegated);
  });

  // A proxy that already has a delegate was registered before eve got here.
  if (hasTracerProviderDelegate(proxy)) observe(proxy.getDelegate());
}
