---
"eve": minor
---

Remove the `fallback` option from dynamic agent model definitions. Dynamic model event handlers must now return a model, and a missing, invalid, or failed selection stops the run.
