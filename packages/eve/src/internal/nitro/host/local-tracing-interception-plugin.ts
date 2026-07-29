import { installGlobalTracerProviderInterception } from "#harness/intercept-global-tracer-provider.js";

/**
 * Claims the global tracer-provider slot before authored `instrumentation.ts`
 * runs, so eve observes tracers the authored `setup()` creates as well as ones
 * created later. `local-tracing-runtime-plugin.ts` runs after that setup and
 * hands the trace writer over.
 *
 * Deliberately at module scope, and first in the plugin list: this has to be in
 * place before any other plugin module body can register a provider.
 *
 * Only added to the dev host when the agent authors an `instrumentation.ts`;
 * with no author to race, the trace-writer plugin registers a provider of its
 * own and needs no interception.
 */
installGlobalTracerProviderInterception();

export default function installLocalTracingInterceptionPlugin(): void {}
