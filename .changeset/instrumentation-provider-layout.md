---
"eve": patch
---

Add the experimental `agent/instrumentation/` provider layout with durable lifecycle handlers, including user input boundaries and action settlement-time, outcome, error-code, and usage metadata, final setup context, reserved OpenTelemetry destinations, and coordinated flush and shutdown. OpenTelemetry singleton settings and destinations are exposed through `eve/instrumentation/otel`, and eve's AI SDK bridge composes with registered integrations.
