---
"eve": minor
---

`defineDynamic` definitions now resolve exclusively from event handlers. Dynamic model handlers must return a model, missing or invalid selections stop the run, and eve resolves omitted context-window metadata from the AI Gateway catalog at runtime.
