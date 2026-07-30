---
"eve": patch
---

Add an explicit development-only selfmod subagent that can propose and apply changes to an agent's live authored directory while `eve dev` is running. Every proposal has a scrollable, file-by-file diff viewer for required human approval before writing; hosted builds omit the capability entirely.
