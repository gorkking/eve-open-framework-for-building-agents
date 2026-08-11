---
"eve": patch
---

Give every instrumentation lifecycle event a replay-stable `idempotencyKey` derived from durable eve identity, allowing providers to upsert one record across retries and worker replays.
