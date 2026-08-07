import type { SpanProcessor } from "#compiled/@vercel/otel/index.js";

import {
  withoutDeclinedContent,
  type ResolvedContentOptions,
} from "#tracing/content-attributes.js";
import { hasSessionRelease, type LocalTracesProcessor } from "#tracing/local-traces.js";

/** Gives one destination a redacted copy without mutating the shared span. */
export function contentFilteringProcessor(
  downstream: SpanProcessor,
  content: ResolvedContentOptions,
): SpanProcessor {
  const filtering: SpanProcessor = {
    forceFlush: () => downstream.forceFlush(),
    onEnd: (span) => {
      downstream.onEnd(redacted(span, content));
    },
    onStart: (span, parentContext) => {
      downstream.onStart(span, parentContext);
    },
    shutdown: () => downstream.shutdown(),
  };

  if (!hasSessionRelease(downstream)) return filtering;
  const releasing: LocalTracesProcessor = {
    ...filtering,
    releaseSession: (sessionId) => downstream.releaseSession(sessionId),
  };
  return releasing;
}

function redacted(span: unknown, content: ResolvedContentOptions): unknown {
  if (typeof span !== "object" || span === null) return span;

  const attributes = (span as { readonly attributes?: unknown }).attributes;
  if (typeof attributes !== "object" || attributes === null) return span;

  const kept = withoutDeclinedContent(attributes as Record<string, unknown>, content);
  if (kept === undefined) return span;

  return Object.create(span, {
    attributes: { configurable: true, enumerable: true, value: kept },
  });
}
