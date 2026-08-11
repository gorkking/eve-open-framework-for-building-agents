import type {
  InstrumentationDefinition,
  InstrumentationSetupContext,
} from "#public/instrumentation/index.js";
import { createInstrumentationHooks } from "#harness/instrumentation-lifecycle.js";
import { registerInstrumentationRuntime } from "#harness/instrumentation-runtime.js";

/**
 * Process-global store for the authored instrumentation config.
 *
 * Populated at server startup by the generated Nitro instrumentation plugin
 * when the user's `agent/instrumentation.ts` has a default export produced
 * by `defineInstrumentation()`. The harness reads from this at turn time
 * to decide whether telemetry is enabled and which settings to pass to the
 * AI SDK.
 *
 * Rooted on `globalThis` so the generated Nitro instrumentation plugin
 * (which Nitro keeps external by `file://` URL) and the bundled harness
 * chunk (which Nitro inlines via the package's `#harness/*` import alias)
 * share one source of truth, even though they resolve to two distinct ESM
 * module instances. See `context/key.ts` and
 * `runtime/sessions/runtime-session.ts` for the established pattern.
 */
const INSTRUMENTATION_CONFIG_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-config");

interface InstrumentationConfigGlobal {
  [INSTRUMENTATION_CONFIG_GLOBAL_KEY]?: InstrumentationDefinition;
}

const globalContainer = globalThis as typeof globalThis & InstrumentationConfigGlobal;

/**
 * Registers the authored instrumentation config and invokes its `setup`
 * callback with the resolved agent name.
 *
 * Called once by the generated instrumentation Nitro plugin at server
 * startup. Subsequent calls overwrite the previous value.
 *
 * @internal — not part of the public API.
 */
export async function registerInstrumentationConfig(
  config: InstrumentationDefinition,
  context: InstrumentationSetupContext,
): Promise<void> {
  globalContainer[INSTRUMENTATION_CONFIG_GLOBAL_KEY] = config;
  registerInstrumentationRuntime({
    forceFlush: async () => undefined,
    hooks: createInstrumentationHooks([]),
    otelSettings: {
      functionId: config.functionId,
      recordInputs: config.recordInputs,
      recordOutputs: config.recordOutputs,
      traceChannelRequests: config.traceChannelRequests === true,
    },
    runInContext: (_operation, execute) => execute(),
    shutdown: async () => undefined,
  });
  await config.setup?.(context);
}

/**
 * Returns the registered instrumentation config, or `undefined` when no
 * `defineInstrumentation` export was provided.
 *
 * @internal — not part of the public API.
 */
export function getInstrumentationConfig(): InstrumentationDefinition | undefined {
  return globalContainer[INSTRUMENTATION_CONFIG_GLOBAL_KEY];
}
