---
"eve": patch
---

Instrumentation lifecycle events now use eve-owned payloads and flat event names, including `step.attempt.*` and durable `input.requested`/`input.resolved` boundaries, instead of AI SDK callback types and paired hooks. Existing spans and attributes are unchanged.
