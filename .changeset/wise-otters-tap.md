---
"eve": patch
---

Local dev tracing now stays on when an agent authors `agent/instrumentation.ts`. Instead of standing down, `eve dev` adopts the tracer provider your `setup` registered, so your exporter keeps receiving everything it did before and additionally sees eve's `agent.*` spans, while `.eve/traces/v1`, `eve trace ls`, and `eve trace <id>` keep working. Production is unchanged; `EVE_TRACES=off` still opts out of the local writer.
