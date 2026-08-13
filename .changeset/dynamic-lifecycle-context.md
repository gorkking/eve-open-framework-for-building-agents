---
"eve": patch
---

Expose message snapshots and cancellation signals in hook contexts. Dynamic resolvers receive the latest durable message snapshot across lifecycle events, dynamic tools can opt into fail-closed resolution with `onError: "throw"`, and durable tools fail closed when replay functions are unavailable.
