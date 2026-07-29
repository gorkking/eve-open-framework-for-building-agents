---
"eve": patch
---

Keep Workflow SDK spans out of `eve trace` when an agent authors its own
instrumentation. eve now reads a span's instrumentation scope under both the
`@opentelemetry/sdk-trace-base` 2.x name and the 1.x one, so a provider built on
the older SDK no longer spools a run's internal spans into `.eve/traces/v1`.
