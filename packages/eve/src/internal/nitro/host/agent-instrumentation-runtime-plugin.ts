import { getInstrumentationConfig } from "#harness/instrumentation-config.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { installAgentInstrumentationRuntime } from "#tracing/agent-instrumentation-runtime.js";

const instrumentation = getInstrumentationConfig();
if (instrumentation !== undefined) {
  installAgentInstrumentationRuntime({
    frameworkVersion: resolveInstalledPackageInfo().version,
    recordInputs: instrumentation.recordInputs,
    recordOutputs: instrumentation.recordOutputs,
  });
}

export default function installAgentInstrumentationRuntimePlugin(): void {}
