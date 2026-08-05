---
"eve": patch
---

Preserve live input and output validators for replayed dynamic tools, so Zod refinements and transforms continue to run after session- and turn-scoped schemas cross durable workflow steps. eve now warns when a live schema cannot be reconstructed instead of silently relying on a potentially lossy JSON Schema representation.
