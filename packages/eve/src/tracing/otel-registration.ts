import { context, propagation, trace, type Context } from "#compiled/@opentelemetry/api/index.js";
import {
  registerOTel,
  type Configuration,
  type SpanProcessor,
} from "#compiled/@vercel/otel/index.js";

import { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { OtelOptions } from "#tracing/otel-declaration.js";

const REGISTRATION_SPAN_NAME = "eve.otel.registration";

class RegistrationMarkerPropagator {
  #injected = false;

  extract(carrierContext: Context): Context {
    return carrierContext;
  }

  fields(): string[] {
    return [];
  }

  inject(): void {
    this.#injected = true;
  }

  isInstalled(): boolean {
    this.#injected = false;
    propagation.inject(context.active(), {}, { set: () => {} });
    return this.#injected;
  }
}

/** Keeps eve's ownership check out of every authored destination. */
class PrivateSpanFilteringProcessor implements SpanProcessor {
  private readonly processors: readonly SpanProcessor[];

  constructor(processors: readonly SpanProcessor[]) {
    this.processors = processors;
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.processors.map((processor) => processor.forceFlush()));
  }

  onEnd(span: unknown): void {
    if (isRegistrationSpan(span)) return;
    for (const processor of this.processors) processor.onEnd(span);
  }

  onStart(span: unknown, parentContext: unknown): void {
    if (isRegistrationSpan(span)) return;
    for (const processor of this.processors) processor.onStart(span, parentContext);
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.processors.map((processor) => processor.shutdown()));
  }
}

/**
 * Builds the process's one OpenTelemetry tracer provider from a merged
 * declaration, then proves it took the global slot.
 *
 * `registerOTel` reports a refused registration only through `diag`, which
 * goes nowhere unless `OTEL_LOG_LEVEL` is set, so a second caller would export
 * nothing and say nothing. eve primes its id generator and installs a private
 * propagator, then verifies both through the global APIs.
 */
export function registerOtelPipeline(input: {
  readonly options: OtelOptions;
  readonly serviceName: string;
}): AgentSpanIdGenerator {
  const { options } = input;
  const idGenerator = new AgentSpanIdGenerator();
  const markerPropagator = new RegistrationMarkerPropagator();
  const configuration: Configuration = {
    attributes: options.resource,
    autoDetectResources: false,
    idGenerator,
    // eve imports the model SDK before any of this runs, so an auto
    // instrumentation registered here could not patch it anyway.
    instrumentations: [],
    propagators: [...(options.propagators ?? ["none"]), markerPropagator],
    serviceName: input.serviceName,
    spanProcessors: [new PrivateSpanFilteringProcessor(options.spanProcessors ?? [])],
  };
  registerOTel(
    // Absent means "let `@vercel/otel` decide", which is not the same as
    // passing an explicit `undefined` sampler.
    options.sampler === undefined
      ? configuration
      : { ...configuration, traceSampler: options.sampler },
  );

  if (!globalTracerUses(idGenerator)) {
    throw new Error(
      "eve could not register OpenTelemetry because another runtime already owns the global tracer provider. Remove the other `registerOTel` call, or move its exporters into eve's `otel({ spanProcessors: [...] })`.",
    );
  }
  if (!markerPropagator.isInstalled()) {
    throw new Error(
      "eve could not register OpenTelemetry because another runtime already owns the global propagator. Remove the other global propagator registration and declare propagators through eve's `otel()` instead.",
    );
  }
  return idGenerator;
}

function globalTracerUses(idGenerator: AgentSpanIdGenerator): boolean {
  const spanId = idGenerator.allocateSpanId();
  const probe = idGenerator.withSpanId(spanId, () =>
    trace.getTracer("eve.registration").startSpan(REGISTRATION_SPAN_NAME),
  );
  // Deliberately not ended: named processors are resolved inside @vercel/otel
  // and cannot be wrapped, while an unended span is never exported.
  return probe.spanContext().spanId === spanId;
}

function isRegistrationSpan(span: unknown): boolean {
  return (
    typeof span === "object" &&
    span !== null &&
    "name" in span &&
    span.name === REGISTRATION_SPAN_NAME
  );
}
