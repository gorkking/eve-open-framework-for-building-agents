---
"eve": patch
---

Fixed a turn failure when a provider-executed tool (e.g. gateway `web_search` on Opus 5) reported its result both inline in the assistant message and as a separately synthesized tool-error for the same call. The harness now keeps a single `tool_result` per tool-use id, so the next model call no longer fails with "each tool_use must have a single result".
