---
"eve": patch
---

Move `eve dev` toward agent-centric traces by keeping Workflow SDK spans out of an
authored exporter as well as the local store. A turn runs
inside a durable step, so a single turn used to send dozens of `step.execute`-style
spans to the exporter your `instrumentation.ts` configures; eve now declines to
create them while the dev server is running, for your exporter as well as for
`.eve/traces/v1`. Spans that were nested under one still attach to the nearest span
above it, and production is unchanged.
