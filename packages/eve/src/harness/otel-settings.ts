import type { OtelHarnessSettings } from "#tracing/otel-declaration.js";

/**
 * Process-global store for the telemetry settings the harness reads per turn.
 *
 * It exists because the two layouts declare the same settings in different
 * shapes — `agent/instrumentation.ts` as fields on the config object,
 * `agent/instrumentation/otel.ts` as `otel()` options — and the harness should
 * not know which one the build used. Whichever registered writes here; the
 * turn loop and the channel-request wrapper only read.
 *
 * Its presence is also the signal that telemetry is on at all. Rooted on
 * `globalThis` for the reason the other instrumentation stores are: the
 * generated Nitro plugin stays external by `file://` URL while the harness
 * chunk is inlined, so the two are distinct ESM module instances.
 */
const OTEL_SETTINGS_GLOBAL_KEY = Symbol.for("eve.harness-otel-settings");

interface OtelSettingsGlobal {
  [OTEL_SETTINGS_GLOBAL_KEY]?: OtelHarnessSettings;
}

const globalContainer = globalThis as typeof globalThis & OtelSettingsGlobal;

/** @internal — not part of the public API. */
export function activateOtelSettings(settings: OtelHarnessSettings): void {
  globalContainer[OTEL_SETTINGS_GLOBAL_KEY] = settings;
}

/**
 * The active settings, or `undefined` when nothing declared telemetry.
 *
 * @internal — not part of the public API.
 */
export function getOtelSettings(): OtelHarnessSettings | undefined {
  return globalContainer[OTEL_SETTINGS_GLOBAL_KEY];
}
