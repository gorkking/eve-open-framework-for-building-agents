---
"eve": patch
---

Add a scope-neutral `fileMemory()` provider with indexed save and remove tools, a configurable 100-memory default limit, and a portable versioned-document backend. Development defaults to process-local storage; Vercel deployments with an attached Blob store select private Blob storage automatically, while other production configurations must provide a backend.
