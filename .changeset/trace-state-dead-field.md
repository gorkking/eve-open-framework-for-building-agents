---
"eve": patch
---

Remove a dead `channelKind` field from local trace session state and collapse the per-attempt model and tool context maps into one, keyed by the operation id that already distinguishes them.
