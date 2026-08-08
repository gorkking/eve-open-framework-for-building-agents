import { trace } from "#compiled/@opentelemetry/api/index.js";

import { ContextAgentTraceStateStore } from "#tracing/agent-trace-context-store.js";
import { createAgentOtelInstrumentation } from "#tracing/agent-otel-provider.js";
import {
  createInstrumentationHooks,
  type InstrumentationProviderDefinition,
} from "#harness/instrumentation-lifecycle.js";
import {
  getInstrumentationRuntime,
  registerInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#harness/instrumentation-runtime.js";
import { localTraces } from "#tracing/local-traces.js";
import { mergeOtelDeclarations, otel } from "#tracing/otel-declaration.js";
import { registerOtelPipeline } from "#tracing/otel-registration.js";

/** Installs the zero-config local OTel runtime once in an `eve dev` worker. */
export function installLocalInstrumentationRuntime(input: {
  readonly appRoot: string;
  readonly frameworkVersion: string;
  readonly serviceName: string;
}): InstrumentationRuntime {
  const existing = getInstrumentationRuntime();
  if (existing !== undefined) return existing;

  // The zero-config default expressed with the same primitive an authored
  // `instrumentation.ts` would use, so this path exercises it.
  const spool = localTraces({ appRoot: input.appRoot });
  const merged = mergeOtelDeclarations([otel({ spanProcessors: [spool] })]);
  const idGenerator = registerOtelPipeline({
    options: merged ?? {},
    serviceName: input.serviceName,
  });

  const agentOtel = createAgentOtelInstrumentation({
    captureContent: process.env.EVE_TRACES_CONTENT !== "off",
    frameworkVersion: input.frameworkVersion,
    idGenerator,
    stateStore: new ContextAgentTraceStateStore(),
    tracer: trace.getTracer("eve.agent", input.frameworkVersion),
  });
  const releaseTrace: InstrumentationProviderDefinition = {
    events: {
      "session.completed": releaseSessionTrace,
      "session.failed": releaseSessionTrace,
    },
  };

  return registerInstrumentationRuntime({
    forceFlush: () => spool.forceFlush(),
    hooks: createInstrumentationHooks([agentOtel.hook, releaseTrace]),
    runInContext: agentOtel.runInContext,
  });

  async function releaseSessionTrace(event: { readonly sessionId: string }): Promise<void> {
    await spool.releaseSession(event.sessionId);
  }
}
