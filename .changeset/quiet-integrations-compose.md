---
"eve": patch
---

Telemetry integrations registered with the AI SDK's `registerTelemetry` no longer stop receiving events once eve attaches its own instrumentation bridge to a model call. eve now composes its bridge with every registered integration instead of replacing them.
