---
"eve": patch
---

Reconstruct durable `agent.action` spans when runtime actions settle, including across worker replacement, and record each action's exact caller-accepted duration, kind, outcome, stable error code, and subagent usage. Remote eve sessions join the caller action trace through W3C `traceparent`; older receivers may ignore the header. Human approval waits appear as durable `agent.approval` child spans, while chat spans use standard self-contained model input and output attributes.
