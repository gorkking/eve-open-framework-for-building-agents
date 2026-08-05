---
"eve": patch
---

Instrumentation providers now subscribe to flat lifecycle event names matching each payload's `type`, instead of paired `before`/`after` hooks. Internal groundwork for a public provider surface; no change to the spans or attributes eve records.
