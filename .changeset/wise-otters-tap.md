---
"eve": patch
---

Local dev tracing now stays on when an agent authors `agent/instrumentation.ts`. Instead of standing down, `eve dev` observes the tracer provider your `setup` registered — including tracers the setup itself took before eve's writer existed — so your exporter keeps receiving everything it did before and additionally sees eve's `agent.*` spans, while `.eve/traces/v1`, `eve trace ls`, and `eve trace <id>` keep working. `setup` may now be `async`: eve awaits it before anything else looks for a tracer provider. Production is unchanged; `EVE_TRACES=off` still opts out of the local writer.
