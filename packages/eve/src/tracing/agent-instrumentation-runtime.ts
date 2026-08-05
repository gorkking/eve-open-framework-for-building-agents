import { trace } from "#compiled/@opentelemetry/api/index.js";

import {
  createInstrumentationHooks,
  type InstrumentationProviderDefinition,
} from "#harness/instrumentation-lifecycle.js";
import {
  getInstrumentationRuntime,
  registerInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#harness/instrumentation-runtime.js";
import { ContextAgentTraceStateStore } from "#tracing/agent-trace-context-store.js";
import { createAgentOtelInstrumentation } from "#tracing/agent-otel-provider.js";

/** Installs eve's structural agent span runtime against the active OTel provider. */
export function installAgentInstrumentationRuntime(input: {
  readonly forceFlush?: () => Promise<void>;
  readonly frameworkVersion: string;
  readonly providers?: readonly InstrumentationProviderDefinition[];
  readonly recordInputs?: boolean;
  readonly recordOutputs?: boolean;
}): InstrumentationRuntime {
  const existing = getInstrumentationRuntime();
  if (existing !== undefined) return existing;

  const agentOtel = createAgentOtelInstrumentation({
    frameworkVersion: input.frameworkVersion,
    recordInputs: input.recordInputs,
    recordOutputs: input.recordOutputs,
    stateStore: new ContextAgentTraceStateStore(),
    tracer: trace.getTracer("eve.agent", input.frameworkVersion),
  });

  return registerInstrumentationRuntime({
    forceFlush: input.forceFlush ?? (() => Promise.resolve()),
    hooks: createInstrumentationHooks([agentOtel.hook, ...(input.providers ?? [])]),
    runInContext: agentOtel.runInContext,
  });
}
