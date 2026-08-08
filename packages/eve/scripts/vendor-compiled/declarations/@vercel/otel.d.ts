export interface SpanProcessor {
  forceFlush(): Promise<void>;
  onEnd(span: unknown): void;
  onStart(span: unknown, parentContext: unknown): void;
  shutdown(): Promise<void>;
}

export interface IdGenerator {
  generateSpanId(): string;
  generateTraceId(): string;
}

/**
 * A `TextMapPropagator`, or one of the names `@vercel/otel` resolves for you.
 * Structural rather than imported: the instance comes from whichever
 * `@opentelemetry/*` build the app installed, not from eve's.
 */
export type PropagatorOrName =
  | { inject(...args: never[]): void; extract(...args: never[]): unknown; fields(): string[] }
  | "auto"
  | "none"
  | "tracecontext"
  | "baggage";

/** A `Sampler`, or one of the names `@vercel/otel` resolves for you. */
export type SamplerOrName =
  | { shouldSample(...args: never[]): unknown; toString(): string }
  | "auto"
  | "always_off"
  | "always_on"
  | "parentbased_always_off"
  | "parentbased_always_on"
  | "parentbased_traceidratio"
  | "traceidratio";

export interface Configuration {
  readonly attributes?: Readonly<Record<string, unknown>>;
  readonly autoDetectResources?: boolean;
  readonly idGenerator?: IdGenerator;
  readonly instrumentations?: readonly unknown[];
  readonly propagators?: readonly PropagatorOrName[];
  readonly serviceName?: string;
  readonly spanProcessors?: readonly SpanProcessor[];
  readonly traceSampler?: SamplerOrName;
}

export declare function registerOTel(configuration?: Configuration | string): void;
