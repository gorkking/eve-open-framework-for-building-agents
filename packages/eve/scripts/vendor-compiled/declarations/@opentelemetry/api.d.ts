export interface SpanContext {
  isRemote?: boolean;
  spanId: string;
  traceFlags: number;
  traceId: string;
  traceState?: unknown;
}

export interface Span {
  addEvent(name: string, attributes?: Attributes): this;
  end(endTime?: number): void;
  isRecording?(): boolean;
  recordException(
    exception: Error | string | { message?: string; name?: string; stack?: string },
  ): void;
  setAttribute(key: string, value: AttributeValue): this;
  setStatus(status: { code: SpanStatusCode; message?: string | undefined }): this;
  spanContext(): SpanContext;
}

export interface SpanOptions {
  attributes?: Attributes | undefined;
  root?: boolean | undefined;
}

export interface Tracer {
  startSpan(name: string, options?: SpanOptions, context?: Context): Span;
}

export interface TracerProvider {
  getTracer(name: string, version?: string, options?: unknown): Tracer;
}

export declare class ProxyTracerProvider implements TracerProvider {
  getDelegate(): TracerProvider;
  /** `undefined` until a delegate is set — how eve tells an unclaimed proxy from a claimed one. */
  getDelegateTracer(name: string, version?: string, options?: unknown): Tracer | undefined;
  getTracer(name: string, version?: string, options?: unknown): Tracer;
  setDelegate(delegate: TracerProvider): void;
}

export interface Context {}

export declare const ROOT_CONTEXT: Context;

export declare enum SpanStatusCode {
  UNSET = 0,
  OK = 1,
  ERROR = 2,
}

export declare const context: {
  active(): Context;
  with<T>(context: Context, fn: () => T): T;
};

export declare const trace: {
  getActiveSpan(): Span | undefined;
  getTracer(name: string, version?: string): Tracer;
  getTracerProvider(): TracerProvider;
  setSpan(context: Context, span: Span): Context;
  wrapSpanContext(spanContext: SpanContext): Span;
};

export declare enum SpanKind {
  INTERNAL = 0,
  SERVER = 1,
  CLIENT = 2,
  PRODUCER = 3,
  CONSUMER = 4,
}
export type AttributeValue =
  | string
  | number
  | boolean
  | Array<string | null | undefined>
  | Array<number | null | undefined>
  | Array<boolean | null | undefined>;

export type Attributes = Record<string, AttributeValue | undefined>;
