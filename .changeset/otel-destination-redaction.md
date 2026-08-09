---
"eve": patch
---

OpenTelemetry destinations can independently decline input or output content. Redaction covers span attributes, exception and custom events, and status messages without mutating spans shared with other destinations; `EVE_TRACES_CONTENT=off` now narrows only local traces.
