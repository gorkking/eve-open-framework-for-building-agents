import type {
  PropagatorOrName,
  SamplerOrName,
  SpanProcessor,
} from "#compiled/@vercel/otel/index.js";

/**
 * OpenTelemetry pipeline settings for one `otel()` declaration.
 *
 * `contextManager` and `instrumentations` are deliberately absent: eve's span
 * nesting depends on the former, and the latter cannot reach anything eve
 * imported before setup ran.
 */
export interface OtelOptions {
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
  /**
   * Where eve exports this agent's traces, and the only field most agents set.
   * Absent means nowhere, eve's own sinks included.
   */
  readonly spanProcessors?: readonly SpanProcessor[];
}

const OTEL_DECLARATION = Symbol.for("eve.instrumentation.otel");

/**
 * One declared OpenTelemetry pipeline. eve collects every declaration before
 * building the tracer provider, so this is a value rather than a side effect.
 */
export interface OtelDeclaration {
  readonly [OTEL_DECLARATION]: true;
  readonly options: OtelOptions;
}

/** Declares the OpenTelemetry pipeline eve should build. */
export function otel(options: OtelOptions = {}): OtelDeclaration {
  return { [OTEL_DECLARATION]: true, options };
}

export function isOtelDeclaration(value: unknown): value is OtelDeclaration {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as Partial<OtelDeclaration>)[OTEL_DECLARATION] === true
  );
}

/** The settings a process can only hold one of, so two declarations collide. */
const SINGLETONS = ["resource", "sampler", "propagators"] as const;

/**
 * Merges every declaration into the one pipeline a process can register.
 *
 * `spanProcessors` concatenate in declaration order. The rest cannot: one
 * process has one tracer provider, so it has one resource, one sampler, and
 * one propagator set. Two declarations of the same one is a boot error rather
 * than a silent win for whichever eve happened to visit first.
 */
export function mergeOtelDeclarations(
  declarations: readonly OtelDeclaration[],
): OtelOptions | undefined {
  if (declarations.length === 0) return undefined;

  const spanProcessors: SpanProcessor[] = [];
  const owners = new Map<(typeof SINGLETONS)[number], number>();
  let merged: OtelOptions = {};
  declarations.forEach(({ options }, index) => {
    spanProcessors.push(...(options.spanProcessors ?? []));
    for (const key of SINGLETONS) {
      if (options[key] === undefined) continue;
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw new Error(
          `Instrumentation declares \`${key}\` in more than one \`otel()\` call (${String(owner)} and ${String(index)}). One process has one OpenTelemetry tracer provider, so it has one \`${key}\` — declare it once.`,
        );
      }
      owners.set(key, index);
      merged = { ...merged, [key]: options[key] };
    }
  });

  return { ...merged, spanProcessors };
}
