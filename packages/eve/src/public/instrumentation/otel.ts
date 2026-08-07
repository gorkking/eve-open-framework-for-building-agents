/**
 * The OpenTelemetry authoring surface for `agent/instrumentation/`.
 *
 * Two halves, because OpenTelemetry has two: `otel()` is the settings a process
 * can only hold one of, and an integration is a destination, of which there may
 * be as many as there are files.
 *
 * Reachable only with `experimental.instrumentationProviders` on. With the flag
 * off nothing discovers that directory, so these compile but never run.
 */

import { createLocalTracesProcessor, resolveLocalTracesContent } from "#tracing/local-traces.js";
import { contentFilteringProcessor } from "#tracing/content-span-processor.js";
import {
  agentRunsIntegration,
  otelIntegration,
  type ContentOptions,
  type OtelIntegration,
} from "#tracing/otel-declaration.js";

export {
  isOtelDeclaration,
  isOtelIntegration,
  otel,
  otelIntegration,
  type ContentOptions,
  type OtelDeclaration,
  type OtelIntegration,
  type OtelIntegrationOptions,
  type OtelOptions,
} from "#tracing/otel-declaration.js";

export type { SpanExporter, SpanProcessor } from "#compiled/@vercel/otel/index.js";

/** Vercel Agent Runs, enabled by default in production. */
export function agentRuns(options: ContentOptions = {}): OtelIntegration {
  return agentRunsIntegration(options);
}

/**
 * The local trace spool `eve dev` reads, as a destination.
 *
 * Export it from `agent/instrumentation/local.ts` to keep it alongside a hosted
 * backend, or export `disableInstrumentation()` from that file to turn it off.
 * Omitting the file leaves eve's default in place.
 * `EVE_TRACES_CONTENT=off` narrows this destination only.
 */
export function localTraces(options: ContentOptions = {}): OtelIntegration {
  const content = resolveLocalTracesContent(options);
  const spool = createLocalTracesProcessor();
  return {
    ...otelIntegration(),
    content,
    spanProcessors:
      content.recordInputs && content.recordOutputs
        ? [spool]
        : [contentFilteringProcessor(spool, content)],
  };
}
