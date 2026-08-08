import { createInstrumentationSetupContext } from "#harness/instrumentation-setup-context.js";
import {
  isInstrumentationDisabled,
  isInstrumentationProvider,
  type InstrumentationProvider,
} from "#public/instrumentation/provider.js";

/**
 * Process-global registry of the providers authored under
 * `agent/instrumentation/`.
 *
 * Rooted on `globalThis` for the same reason the single-config store is: the
 * generated Nitro plugin stays external by `file://` URL while the harness
 * chunk is inlined, so the two resolve to distinct ESM module instances and
 * need one shared source of truth.
 */
const INSTRUMENTATION_PROVIDERS_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-providers");

/** One provider and the `instrumentation/<slot>.ts` file it came from. */
export interface RegisteredInstrumentationProvider {
  readonly provider: InstrumentationProvider;
  readonly slot: string;
}

interface InstrumentationProvidersGlobal {
  [INSTRUMENTATION_PROVIDERS_GLOBAL_KEY]?: Map<string, InstrumentationProvider>;
}

const globalContainer = globalThis as typeof globalThis & InstrumentationProvidersGlobal;

function providerRegistry(): Map<string, InstrumentationProvider> {
  const existing = globalContainer[INSTRUMENTATION_PROVIDERS_GLOBAL_KEY];
  if (existing !== undefined) {
    return existing;
  }

  const created = new Map<string, InstrumentationProvider>();
  globalContainer[INSTRUMENTATION_PROVIDERS_GLOBAL_KEY] = created;
  return created;
}

/**
 * Registers one authored provider and awaits its `setup`.
 *
 * Called once per `instrumentation/<slot>.ts` by the generated Nitro plugin at
 * server startup, before any event is published. A default export that is not
 * a `defineInstrumentation` result throws rather than being skipped: a slot
 * that registers nothing is telemetry that silently does nothing, which is the
 * failure this surface exists to prevent.
 *
 * @internal — not part of the public API.
 */
export async function registerInstrumentationProvider(input: {
  readonly agentName: string;
  readonly slot: string;
  readonly value: unknown;
}): Promise<void> {
  if (isInstrumentationDisabled(input.value)) {
    providerRegistry().delete(input.slot);
    return;
  }

  if (!isInstrumentationProvider(input.value)) {
    throw new Error(
      `The default export of "instrumentation/${input.slot}" is not an instrumentation provider. Return the result of \`defineInstrumentation\` or \`disableInstrumentation\` from it.`,
    );
  }

  providerRegistry().set(input.slot, input.value);
  await input.value.setup?.(createInstrumentationSetupContext(input.agentName));
}

/** Registered providers in slot order. @internal */
export function getInstrumentationProviders(): readonly RegisteredInstrumentationProvider[] {
  return [...providerRegistry()].map(([slot, provider]) => ({ provider, slot }));
}
