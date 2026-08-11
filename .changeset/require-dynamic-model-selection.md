---
"eve": minor
---

Remove the `fallback` option from dynamic agent model definitions. Dynamic model event handlers must now return a model, missing or invalid selections stop the run, and eve resolves omitted context-window metadata from the AI Gateway catalog at runtime.
