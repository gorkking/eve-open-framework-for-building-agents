import type {
  PropagatorOrName,
  SamplerOrName,
  SpanExporter,
  SpanProcessor,
  SpanProcessorOrName,
} from "#compiled/@vercel/otel/index.js";

import { batchSpanProcessor } from "#tracing/batch-span-processor.js";
import type { ResolvedContentOptions } from "#tracing/content-attributes.js";
import { contentFilteringProcessor } from "#tracing/content-span-processor.js";
import { vercelRuntimeSpanProcessor } from "#tracing/vercel-runtime-span-exporter.js";

/**
 * The process-wide OpenTelemetry settings, declared by `otel()`.
 *
 * Everything here is a singleton, which is why it is one file: a process has
 * one tracer provider, so it has one resource, one sampler, and one propagator
 * set. Destinations are the plural half and live in `otelIntegration()`.
 *
 * `contextManager` and `instrumentations` are deliberately absent: eve's span
 * nesting depends on the former, and the latter cannot reach anything eve
 * imported before setup ran.
 */
export interface OtelOptions {
  /**
   * The function identifier attached to telemetry spans
   * (`ai.telemetry.functionId`). Defaults to the agent name.
   */
  readonly functionId?: string;
  /**
   * Whether to emit the inbound HTTP `SERVER` span that wraps each channel
   * request — the parent of the turn trace and of any `hook.resume` or
   * outgoing HTTP spans. Defaults to `false`.
   */
  readonly traceChannelRequests?: boolean;
  /**
   * Resource attributes merged into eve's own, which already carry the
   * service name.
   */
  readonly resource?: Readonly<Record<string, unknown>>;
  /**
   * Head sampling, and it is global: it decides whether a span is created at
   * all, so it thins eve's own sinks and the `traceparent` eve propagates
   * along with your exporters. To thin one backend only, drop spans in a
   * processor.
   */
  readonly sampler?: SamplerOrName;
  /** Composed into one propagator. All inject; the first to extract wins. */
  readonly propagators?: readonly PropagatorOrName[];
}

/** What one destination records of the conversation itself. */
export interface ContentOptions {
  /** Record model prompts and tool call inputs. Defaults to `true`. */
  readonly recordInputs?: boolean;
  /** Record model responses and tool call outputs. Defaults to `true`. */
  readonly recordOutputs?: boolean;
}

/** Where one `otelIntegration()` sends spans, and what it records. */
export interface OtelIntegrationOptions extends ContentOptions {
  /** Merged into the pipeline in declaration order. */
  readonly spanProcessors?: readonly SpanProcessor[];
  /** Wrapped in eve's batching processor and appended after `spanProcessors`. */
  readonly traceExporter?: SpanExporter;
}

const OTEL_DECLARATION = Symbol.for("eve.instrumentation.otel");
const OTEL_INTEGRATION = Symbol.for("eve.instrumentation.otel-integration");

/**
 * The declared OpenTelemetry pipeline settings. eve collects this before
 * building the tracer provider, so it is a value rather than a side effect.
 */
export interface OtelDeclaration {
  readonly [OTEL_DECLARATION]: true;
  readonly options: OtelOptions;
}

/** One declared destination. A process may have as many as it has files. */
export interface OtelIntegration {
  readonly [OTEL_INTEGRATION]: true;
  readonly content: ResolvedContentOptions;
  readonly spanProcessors: readonly SpanProcessorOrName[];
}

/**
 * Declares the process-wide OpenTelemetry settings.
 *
 * This remains internal until the provider authoring API exposes it.
 */
export function otel(options: OtelOptions = {}): OtelDeclaration {
  return { [OTEL_DECLARATION]: true, options };
}

/**
 * Declares one destination for this agent's traces.
 *
 * A `traceExporter` is wrapped in eve's batching processor, which is what makes
 * the one-line form of a hosted backend enough. Pass `spanProcessors` instead
 * when the destination needs its own batching, sampling, or filtering.
 */
export function otelIntegration(options: OtelIntegrationOptions = {}): OtelIntegration {
  const content = resolveContentOptions(options);
  const declared = options.spanProcessors ?? [];
  const spanProcessors =
    options.traceExporter === undefined
      ? declared
      : [...declared, batchSpanProcessor(options.traceExporter)];
  return {
    [OTEL_INTEGRATION]: true,
    content,
    spanProcessors:
      content.recordInputs && content.recordOutputs
        ? spanProcessors
        : spanProcessors.map((processor) => contentFilteringProcessor(processor, content)),
  };
}

/** Vercel Agent Runs through the production request-context transport. @internal */
export function agentRunsIntegration(options: ContentOptions = {}): OtelIntegration {
  const content = resolveContentOptions(options);
  return {
    [OTEL_INTEGRATION]: true,
    content,
    spanProcessors:
      content.recordInputs && content.recordOutputs
        ? ["auto"]
        : [contentFilteringProcessor(vercelRuntimeSpanProcessor(), content)],
  };
}

export function resolveContentOptions(options: ContentOptions): ResolvedContentOptions {
  return {
    recordInputs: options.recordInputs !== false,
    recordOutputs: options.recordOutputs !== false,
  };
}

export function isOtelDeclaration(value: unknown): value is OtelDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<OtelDeclaration>)[OTEL_DECLARATION] === true
  );
}

export function isOtelIntegration(value: unknown): value is OtelIntegration {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<OtelIntegration>)[OTEL_INTEGRATION] === true
  );
}

/** The one pipeline a process can register. @internal */
export interface OtelPipeline {
  readonly propagators?: readonly PropagatorOrName[];
  readonly resource?: Readonly<Record<string, unknown>>;
  readonly sampler?: SamplerOrName;
  readonly spanProcessors: readonly SpanProcessorOrName[];
}

/** What the harness reads at turn time, as opposed to at registration. @internal */
export interface OtelHarnessSettings {
  readonly functionId?: string;
  readonly traceChannelRequests: boolean;
  /**
   * What to materialize on spans at all. Each destination independently strips
   * anything it declined before export.
   */
  readonly recordInputs?: boolean;
  readonly recordOutputs?: boolean;
}

/** @internal */
export interface CollectedOtel {
  /**
   * Whether anything declared OpenTelemetry. False means eve should leave the
   * global tracer provider slot alone rather than register an empty pipeline.
   */
  readonly declared: boolean;
  readonly pipeline: OtelPipeline;
  readonly settings: OtelHarnessSettings;
}

/**
 * Folds the declared values into the one pipeline a process can register.
 *
 * Destinations concatenate in declaration order. The singletons cannot: two
 * `otel()` values is a boot error rather than a silent win for whichever eve
 * happened to visit first. With one declaration per file that collision needs
 * two files both exporting `otel()`, which is the only way to reach it.
 *
 * @internal
 */
export function collectOtelPipeline(values: readonly unknown[]): CollectedOtel {
  const spanProcessors: SpanProcessorOrName[] = [];
  let declaration: OtelDeclaration | undefined;
  let declared = false;
  let recordInputs = false;
  let recordOutputs = false;

  for (const value of values) {
    if (isOtelIntegration(value)) {
      declared = true;
      recordInputs ||= value.content.recordInputs;
      recordOutputs ||= value.content.recordOutputs;
      spanProcessors.push(...value.spanProcessors);
      continue;
    }
    if (!isOtelDeclaration(value)) continue;
    if (declaration !== undefined) {
      throw new Error(
        "Instrumentation declares `otel()` more than once. One process has one OpenTelemetry tracer provider, so it has one resource, one sampler, and one propagator set — declare them in a single `otel()`.",
      );
    }
    declared = true;
    declaration = value;
  }

  const options = declaration?.options ?? {};
  return {
    declared,
    pipeline: {
      propagators: options.propagators,
      resource: options.resource,
      sampler: options.sampler,
      spanProcessors,
    },
    settings: {
      functionId: options.functionId,
      recordInputs,
      recordOutputs,
      traceChannelRequests: options.traceChannelRequests === true,
    },
  };
}
