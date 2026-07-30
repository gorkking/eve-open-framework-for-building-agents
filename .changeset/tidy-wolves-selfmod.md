---
"eve": patch
---

Add an explicit development-only selfmod subagent that can propose changes to an agent's live authored directory while `eve dev` is running. Every proposal displays its serialized file edits for required human approval before writing; hosted builds omit the capability entirely.
