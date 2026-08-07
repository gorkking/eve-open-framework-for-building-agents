---
"eve": patch
---

Content capture is now declared per trace destination. `otelIntegration()` takes
`recordInputs` and `recordOutputs`, so a local spool and a hosted backend no
longer have to agree on whether they see prompts and tool results — a
destination that declines never exports them. `EVE_TRACES_CONTENT=off` now
narrows `localTraces()` alone rather than the whole process.
