---
"eve": patch
---

Dynamic tools contributed by framework runtime code (starting with `connection_search`) now flow through one owner-scoped contribution path that validates entries, captures callbacks durably, replaces each contributor's tool set atomically per lifecycle boundary, and cleans up contributors removed by a redeploy — instead of each feature re-implementing dynamic resolution.
