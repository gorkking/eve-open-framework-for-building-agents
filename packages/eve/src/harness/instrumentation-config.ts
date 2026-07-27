import type {
  InstrumentationDefinition,
  InstrumentationSetupContext,
} from "#public/instrumentation/index.js";

/**
 * Process-global store for the authored instrumentation config.
 *
 * Populated at server startup by the generated instrumentation module when
 * the user's `agent/instrumentation.ts` has a default export produced by
 * `defineInstrumentation()`. The harness reads from this at turn time to
 * decide whether telemetry is enabled and which settings to pass to the
 * AI SDK.
 *
 * Rooted on `globalThis` so every copy of that module shares one source of
 * truth: the bundler emits it as the entry's instrumentation preload chunk
 * and as a Nitro plugin (which Nitro keeps external by `file://` URL), and
 * the bundled harness chunk (which Nitro inlines via the package's
 * `#harness/*` import alias) is a third instance. See `context/key.ts` and
 * `runtime/sessions/runtime-session.ts` for the established pattern.
 */
const INSTRUMENTATION_CONFIG_GLOBAL_KEY = Symbol.for("eve.harness-instrumentation-config");

/**
 * Tracks whether `setup` already ran in this process. Rooted on
 * `globalThis` for the same reason as the config itself: the instrumentation
 * preload chunk and the Nitro plugin can resolve to two distinct module
 * instances, and `setup` must still run only once.
 */
const INSTRUMENTATION_SETUP_INVOKED_GLOBAL_KEY = Symbol.for(
  "eve.harness-instrumentation-setup-invoked",
);

interface InstrumentationConfigGlobal {
  [INSTRUMENTATION_CONFIG_GLOBAL_KEY]?: InstrumentationDefinition;
  [INSTRUMENTATION_SETUP_INVOKED_GLOBAL_KEY]?: boolean;
}

const globalContainer = globalThis as typeof globalThis & InstrumentationConfigGlobal;

/**
 * Registers the authored instrumentation config and invokes its `setup`
 * callback with the resolved agent name.
 *
 * Called at server startup by the generated instrumentation module, which
 * the bundler emits both as the entry's preload chunk and as a Nitro
 * plugin. Subsequent calls overwrite the stored config, but `setup` runs
 * only on the first.
 *
 * @internal — not part of the public API.
 */
export function registerInstrumentationConfig(
  config: InstrumentationDefinition,
  context: InstrumentationSetupContext,
): void {
  if (
    config.setup !== undefined &&
    globalContainer[INSTRUMENTATION_SETUP_INVOKED_GLOBAL_KEY] !== true
  ) {
    globalContainer[INSTRUMENTATION_SETUP_INVOKED_GLOBAL_KEY] = true;
    config.setup(context);
  }
  globalContainer[INSTRUMENTATION_CONFIG_GLOBAL_KEY] = config;
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
