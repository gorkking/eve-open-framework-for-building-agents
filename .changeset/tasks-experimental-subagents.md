---
"eve": patch
---

Add experimental background tasks for subagents. Child input requests surface on the parent session and client responses route directly back without a parent model turn; `task_send` continues a finished task, and one child session owns at most one nonterminal task. Without `experimental.tasks`, nothing changes.
