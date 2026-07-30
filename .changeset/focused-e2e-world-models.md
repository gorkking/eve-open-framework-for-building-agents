---
"eve": patch
---

Expand the internal deterministic model adapter for world-focused e2e coverage, including subagent, repeated-tool, fan-out, silent-completion, and schema-derived tool-input programs. Authored `eve-mock/*` models remain intact when automatic model replacement is enabled, and turn cancellation observed as a durable step returns now wins over ordinary completion.
