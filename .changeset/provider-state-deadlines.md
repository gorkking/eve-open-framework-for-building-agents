---
"eve": patch
---

Add durable operation-scoped state to instrumentation handlers, isolated by provider and automatically released at terminal boundaries. Bound each handler and persist start-handler abandonment so a stalled provider cannot block the bus or later receive a mismatched terminal.
