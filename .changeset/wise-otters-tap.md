---
"eve": patch
---

Local dev tracing now stays on when an agent authors `agent/instrumentation.ts`. Instead of standing down, `eve dev` observes the tracer provider your `setup` registered — including tracers your module took before it registered that provider — so your exporter keeps receiving everything it did before and additionally sees eve's `agent.*` spans, while `.eve/traces/v1`, `eve trace ls`, and `eve trace <id>` keep working. `setup` may now be `async`: eve awaits it before installing its writer. If eve cannot observe spans in a given dev worker it logs a warning and leaves your instrumentation alone rather than failing the dev server. Production is unchanged; `EVE_TRACES=off` still opts out of the local writer.
