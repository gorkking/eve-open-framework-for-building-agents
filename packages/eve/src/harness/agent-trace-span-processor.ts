import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

interface SpanLike {
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly instrumentationLibrary?: { readonly name?: string };
  readonly instrumentationScope?: { readonly name?: string };
  readonly spanContext: () => { readonly traceId: string };
}

const WORKFLOW_INSTRUMENTATION_SCOPE = "workflow";

/**
 * The name of the instrumentation that created `span`.
 *
 * `@opentelemetry/sdk-trace-base` 2.x renamed `instrumentationLibrary` to
 * `instrumentationScope`. eve reads spans from providers it did not build — an
 * authored `instrumentation.ts` picks its own SDK version — so both shapes
 * arrive here, and a span whose scope cannot be read is one this processor
 * cannot decide about.
 */
function instrumentationName(span: SpanLike): string | undefined {
  return span.instrumentationScope?.name ?? span.instrumentationLibrary?.name;
}

/** Routes spans from agent-owned traces to provider-neutral child processors. */
export class AgentTraceSpanProcessor implements SpanProcessor {
  readonly #children: readonly SpanProcessor[];
  readonly #ownedTraceIds = new Set<string>();
  readonly #sessionTraceIds = new Map<string, string>();

  constructor(children: readonly SpanProcessor[]) {
    this.#children = children;
  }

  async forceFlush(): Promise<void> {
    await Promise.all(this.#children.map((child) => child.forceFlush()));
  }

  onStart(span: unknown, parentContext: unknown): void {
    if (!isSpanLike(span)) return;
    const sessionId = span.attributes["agent.session.id"];
    if (typeof sessionId === "string") {
      const traceId = span.spanContext().traceId;
      this.#ownedTraceIds.add(traceId);
      this.#sessionTraceIds.set(sessionId, traceId);
    }
    if (!this.#accepts(span)) return;
    for (const child of this.#children) child.onStart(span, parentContext);
  }

  onEnd(span: unknown): void {
    if (!isSpanLike(span) || !this.#accepts(span)) return;
    for (const child of this.#children) child.onEnd(span);
  }

  /** Trace ids whose session is still open, so retention never evicts them. */
  activeTraceIds(): ReadonlySet<string> {
    return this.#ownedTraceIds;
  }

  /** Forgets one session's trace, reporting whether it owned one. */
  releaseSession(sessionId: string): boolean {
    const traceId = this.#sessionTraceIds.get(sessionId);
    if (traceId === undefined) return false;
    this.#ownedTraceIds.delete(traceId);
    this.#sessionTraceIds.delete(sessionId);
    return true;
  }

  async shutdown(): Promise<void> {
    await Promise.all(this.#children.map((child) => child.shutdown()));
  }

  #accepts(span: SpanLike): boolean {
    return (
      instrumentationName(span) !== WORKFLOW_INSTRUMENTATION_SCOPE &&
      this.#ownedTraceIds.has(span.spanContext().traceId)
    );
  }
}

function isSpanLike(value: unknown): value is SpanLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "attributes" in value &&
    "spanContext" in value &&
    typeof value.spanContext === "function"
  );
}
