// Kept in a module of its own, with no imports, because `AgentTraceSpanProcessor`
// reads it and is reachable from the graph eve bundles an authored module out of.
// Importing it from `workflow-instrumentation.ts` would pull the vendored
// `@opentelemetry/api` bundle in behind it, and that bundle's CommonJS shims do
// not survive being nested inside an authored bundle.

/**
 * The instrumentation scope name the Workflow SDK reports its spans under.
 *
 * `@workflow/core` takes a tracer named `workflow` from the global API, so this
 * is the name on every span a run creates — both the ones eve declines to
 * create and the ones it filters on the way to the local store.
 */
export const WORKFLOW_INSTRUMENTATION_SCOPE = "workflow";
