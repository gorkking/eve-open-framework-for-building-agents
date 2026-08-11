import { trace } from "#compiled/@opentelemetry/api/index.js";
import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import {
  createInstrumentationHooks,
  type InstrumentationProviderDefinition,
} from "#harness/instrumentation-lifecycle.js";
import {
  registerInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#harness/instrumentation-runtime.js";
import { createLogger, formatError } from "#internal/logging.js";
import { ContextAgentTraceStateStore } from "#tracing/agent-trace-context-store.js";
import { createAgentOtelInstrumentation } from "#tracing/agent-otel-provider.js";
import { hasSessionRelease, type LocalTracesProcessor } from "#tracing/local-traces.js";
import type { CollectedOtel } from "#tracing/otel-declaration.js";
import { registerOtelPipeline, type RegisteredOtelPipeline } from "#tracing/otel-registration.js";

const log = createLogger("tracing.install-instrumentation-runtime");

/** Installs the bus and the one OpenTelemetry pipeline collected for this process. */
export function installInstrumentationRuntime(input: {
  readonly collected: CollectedOtel;
  readonly frameworkVersion: string;
  readonly providers: readonly InstrumentationProviderDefinition[];
  readonly serviceName: string;
}): InstrumentationRuntime {
  const providers: InstrumentationProviderDefinition[] = [...input.providers];
  let otelRuntime: RegisteredOtelPipeline | undefined;
  let runInContext: InstrumentationRuntime["runInContext"] = (_operation, execute) => execute();

  if (input.collected.declared) {
    otelRuntime = registerOtelPipeline({
      pipeline: input.collected.pipeline,
      serviceName: input.serviceName,
    });
    const agentOtel = createAgentOtelInstrumentation({
      frameworkVersion: input.frameworkVersion,
      idGenerator: otelRuntime.idGenerator,
      recordInputs: input.collected.settings.recordInputs,
      recordOutputs: input.collected.settings.recordOutputs,
      stateStore: new ContextAgentTraceStateStore(),
      tracer: trace.getTracer("eve.agent", input.frameworkVersion),
    });
    providers.unshift(agentOtel.hook);
    runInContext = agentOtel.runInContext;

    const releasable = input.collected.pipeline.spanProcessors
      .filter(isSpanProcessor)
      .filter(hasSessionRelease);
    if (releasable.length > 0) providers.push(sessionReleaseProvider(releasable));
  }

  let shutdown: Promise<void> | undefined;
  return registerInstrumentationRuntime({
    forceFlush: () =>
      settleAll([
        ...(otelRuntime === undefined ? [] : [otelRuntime.forceFlush]),
        ...providers.map((provider) => () => provider.flush?.()),
      ]),
    hooks: createInstrumentationHooks(providers),
    otelSettings: input.collected.declared ? input.collected.settings : undefined,
    runInContext,
    shutdown: () => {
      shutdown ??= settleAll([
        ...(otelRuntime === undefined ? [] : [otelRuntime.shutdown]),
        ...providers.map((provider) => () => provider.shutdown?.()),
      ]);
      return shutdown;
    },
  });
}

function isSpanProcessor(processor: SpanProcessor | "auto"): processor is SpanProcessor {
  return processor !== "auto";
}

function sessionReleaseProvider(
  processors: readonly LocalTracesProcessor[],
): InstrumentationProviderDefinition {
  const release = async (event: { readonly sessionId: string }): Promise<void> => {
    await Promise.all(processors.map((processor) => processor.releaseSession(event.sessionId)));
  };
  return {
    events: { "session.completed": release, "session.failed": release },
    name: "eve.session-release",
  };
}

/** One failing drain must not take the others or the step awaiting them with it. */
async function settleAll(operations: readonly (() => void | PromiseLike<void>)[]): Promise<void> {
  const results = await Promise.allSettled(operations.map(async (run) => run()));
  for (const result of results) {
    if (result.status === "rejected") {
      log.warn("instrumentation drain failed", { error: formatError(result.reason) });
    }
  }
}
