---
"eve": patch
---

Make subagent dispatch replay-safe. Remote create-session requests now carry a replay-stable `operationId`, and the built-in `POST /eve/v1/session` route returns the child it already created for that operation instead of starting a second one. A replayed local start adopts the child holding its deterministic continuation token rather than reporting a start failure.
