---
"eve": patch
---

Add `experimental.instrumentationProviders`, an off-by-default flag that swaps
the single `agent/instrumentation.ts` config for an `agent/instrumentation/`
directory holding one provider per file. With the flag off nothing changes.
With it on, eve compiles every file in that directory, awaits each provider's
`setup` at startup, and fails the build if `agent/instrumentation.ts` is still
present. Authored `setup` now receives `environment` and `frameworkVersion`
alongside `agentName` in both layouts.
