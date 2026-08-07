---
"eve": patch
---

Background task terminal snapshots now retain the child's reported token usage instead of dropping it at the task wire. Accounting is unchanged: background children get a best-effort budget capped at dispatch time, and aggregate spend across sequential dispatches is not yet reserved against the parent's session limits.
