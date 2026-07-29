import { context, trace } from "#compiled/@opentelemetry/api/index.js";
import { registerOTel } from "#compiled/@vercel/otel/index.js";

import { adoptGlobalTracerProvider } from "#harness/adopt-global-tracer-provider.js";
import { createAgentOtelInstrumentation } from "#harness/agent-otel-provider.js";
import { ContextAgentTraceStateStore } from "#harness/agent-trace-context-store.js";
import { AgentTraceSpanProcessor } from "#harness/agent-trace-span-processor.js";
import {
  hasTracerProviderDelegate,
  isDelegatingTracerProvider,
} from "#harness/delegating-tracer-provider.js";
import {
  attachInterceptedSpanProcessor,
  releaseGlobalTracerProviderInterception,
} from "#harness/intercept-global-tracer-provider.js";
import {
  createInstrumentationHooks,
  type InstrumentationProviderDefinition,
} from "#harness/instrumentation-lifecycle.js";
import {
  getInstrumentationRuntime,
  registerInstrumentationRuntime,
  type InstrumentationRuntime,
} from "#harness/instrumentation-runtime.js";
import {
  requestLocalTraceStorePrune,
  resolveLocalTraceRetentionSettings,
} from "#harness/local-trace-retention.js";
import { LocalTraceSpanProcessor } from "#harness/local-trace-span-processor.js";
import { createLogger } from "#internal/logging.js";

const log = createLogger("harness.local-instrumentation-runtime");

/**
 * Installs the zero-config local OTel runtime once in an `eve dev` worker.
 *
 * Returns `undefined` when eve cannot observe spans — a provider registered in
 * a way eve cannot adopt. Local tracing is a development convenience, so it
 * declines rather than taking down a dev server whose authored instrumentation
 * is otherwise working.
 */
export function installLocalInstrumentationRuntime(input: {
  readonly appRoot: string;
  readonly frameworkVersion: string;
  readonly serviceName: string;
}): InstrumentationRuntime | undefined {
  const existing = getInstrumentationRuntime();
  if (existing !== undefined) return existing;

  const retention = resolveLocalTraceRetentionSettings();
  // `EVE_TRACES=off` removes the writer but keeps the runtime: agent context
  // still has to propagate so AI SDK and user spans nest correctly.
  const processor = new AgentTraceSpanProcessor(
    retention.enabled ? [new LocalTraceSpanProcessor(input.appRoot)] : [],
  );
  // A provider an authored `instrumentation.ts` registered is observed rather
  // than displaced, so its exporter keeps everything it had. Only an unclaimed
  // process gets a provider of eve's own.
  if (!attachInterceptedSpanProcessor(processor) && !adoptGlobalTracerProvider(processor)) {
    releaseGlobalTracerProviderInterception();
    registerOTel({
      autoDetectResources: false,
      instrumentations: [],
      propagators: ["none"],
      serviceName: input.serviceName,
      spanProcessors: [processor],
    });
    // Global registration demands an exact API version match, so an agent
    // whose own `@opentelemetry/api` is a different patch release than eve's
    // vendored copy owns the registry outright and refuses eve's provider.
    // `registerOTel` reports that through the diag logger and returns anyway,
    // which would leave a runtime here backed by a no-op tracer.
    if (!hasRegisteredTracerProvider()) {
      log.warn(
        "eve could not register an OpenTelemetry tracer provider, so local traces are not being recorded in this dev worker.",
      );
      return undefined;
    }
  }
  // Spans reach the processor by construction, so there is nothing to probe
  // there — and probing with a real span would make startup depend on the
  // authored sampler, which is free to drop it. A context manager is the one
  // thing eve cannot arrange itself: without one, agent context does not
  // propagate and AI SDK spans would not nest under `agent.step`.
  if (!hasContextManager()) {
    log.warn(
      "eve could not propagate OpenTelemetry context, so local traces are not being recorded in this dev worker.",
    );
    return undefined;
  }
  const agentOtel = createAgentOtelInstrumentation({
    frameworkVersion: input.frameworkVersion,
    stateStore: new ContextAgentTraceStateStore(),
    tracer: trace.getTracer("eve.agent", input.frameworkVersion),
  });
  const releaseTrace: InstrumentationProviderDefinition = {
    events: {
      "session.completed": releaseSessionTrace,
      "session.failed": releaseSessionTrace,
    },
  };
  // Startup sweep: a store left oversized by a killed dev server is bounded
  // before this worker adds to it.
  requestPrune();

  return registerInstrumentationRuntime({
    forceFlush: () => processor.forceFlush(),
    hooks: createInstrumentationHooks([agentOtel.hook, releaseTrace]),
    runInContext: agentOtel.runInContext,
  });

  async function releaseSessionTrace(event: { readonly sessionId: string }): Promise<void> {
    // Settle pending segment writes before dropping liveness: a sweep already
    // running reads the same live set, so releasing first would expose the
    // trace to eviction while it is still being written.
    await processor.forceFlush();
    if (!processor.releaseSession(event.sessionId)) return;
    requestPrune();
  }

  function requestPrune(): void {
    if (!retention.enabled) return;
    requestLocalTraceStorePrune({
      activeTraceIds: processor.activeTraceIds(),
      appRoot: input.appRoot,
      maxAgeMs: retention.maxAgeMs,
      maxTotalBytes: retention.maxTotalBytes,
      retainCount: retention.retainCount,
    });
  }
}

/**
 * Whether a context manager is registered, tested without creating a real
 * span.
 *
 * `wrapSpanContext` builds a span the API owns outright, so the answer does not
 * depend on any provider's sampler and no probe span reaches an exporter.
 */
function hasContextManager(): boolean {
  const probe = trace.wrapSpanContext({
    spanId: "1".repeat(16),
    traceFlags: 0,
    traceId: "1".repeat(32),
  });
  return context.with(
    trace.setSpan(context.active(), probe),
    () => trace.getActiveSpan() === probe,
  );
}

/**
 * Whether the global tracer provider resolves to something that can make spans.
 *
 * A provider that delegates says so through its delegate, since the API hands
 * back a standby proxy even when nothing is registered.
 */
function hasRegisteredTracerProvider(): boolean {
  const provider = trace.getTracerProvider();
  if (!isDelegatingTracerProvider(provider)) return true;
  return hasTracerProviderDelegate(provider);
}
