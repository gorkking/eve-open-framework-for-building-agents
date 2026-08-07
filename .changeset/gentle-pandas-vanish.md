---
"eve": patch
---

Split the OpenTelemetry authoring surface into `otel()` and `otelIntegration()`,
exported from the new `eve/instrumentation/otel` entrypoint. `otel()` declares
the settings a process can only hold one of — resource, sampler, propagators,
`functionId`, `traceChannelRequests` — and an integration declares one
destination, of which an agent may have as many as it has files. Passing
`traceExporter` to an integration wraps it in eve's batching span processor, so
a hosted backend is a one-liner. Local traces remain enabled by default in
development, and Agent Runs uses Vercel's runtime transport by default in
production. Reachable only with `experimental.instrumentationProviders` on.
