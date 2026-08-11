import {
  getInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#harness/instrumentation-runtime.js";
import { installInstrumentationRuntime } from "#tracing/install-instrumentation-runtime.js";
import { createLocalTracesProcessor } from "#tracing/local-traces.js";
import { collectOtelPipeline, otel, otelIntegration } from "#tracing/otel-declaration.js";

/** Installs the zero-config local OTel runtime once in an `eve dev` worker. */
export function installLocalInstrumentationRuntime(input: {
  readonly appRoot: string;
  readonly frameworkVersion: string;
  readonly serviceName: string;
}): InstrumentationRuntime {
  const existing = getInstrumentationRuntime();
  if (existing !== undefined) return existing;

  // The zero-config default expressed with the same values an authored
  // `agent/instrumentation/` would declare, so this path exercises them.
  const spool = createLocalTracesProcessor({ appRoot: input.appRoot });
  const collectedPipeline = collectOtelPipeline([
    otel(),
    otelIntegration({ spanProcessors: [spool] }),
  ]);
  const captureContent = process.env.EVE_TRACES_CONTENT !== "off";
  const collected = {
    ...collectedPipeline,
    settings: {
      ...collectedPipeline.settings,
      recordInputs: captureContent,
      recordOutputs: captureContent,
    },
  };
  return installInstrumentationRuntime({
    collected,
    frameworkVersion: input.frameworkVersion,
    providers: [],
    serviceName: input.serviceName,
  });
}
