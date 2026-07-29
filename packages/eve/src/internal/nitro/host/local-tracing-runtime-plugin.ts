import { basename } from "node:path";

import { installLocalInstrumentationRuntime } from "#harness/local-instrumentation-runtime.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";

/**
 * Installs the local trace writer, from the plugin body rather than at module
 * scope.
 *
 * That is what serializes eve behind an authored `instrumentation.ts` whose
 * `setup` is `async`. Nitro imports every plugin as a static sibling, so a
 * plugin suspended at a top-level `await` does not hold up the next module's
 * evaluation — import order alone is no barrier. Plugin bodies run only once
 * the whole plugin graph has settled, so by the time this one is called the
 * authored provider is registered.
 */
export default function installLocalTracingRuntimePlugin(): void {
  const appRoot = process.env[DEVELOPMENT_WORKER_APP_ROOT_ENV];
  if (appRoot === undefined) {
    throw new Error(`${DEVELOPMENT_WORKER_APP_ROOT_ENV} is required for local tracing.`);
  }

  installLocalInstrumentationRuntime({
    appRoot,
    frameworkVersion: resolveInstalledPackageInfo().version,
    serviceName: basename(appRoot),
  });
}
