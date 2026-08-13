# Shared sandbox

A parent agent and a declared `worker` subagent that operate on the same live
Vercel Sandbox filesystem by returning the parent's durable sandbox value.

- `agent/sandbox.ts` — the parent creates a Vercel Sandbox normally.
- `agent/subagents/worker/sandbox.ts` — the worker returns `parent.sandbox`.
- `evals/shared-filesystem.eval.ts` — proves sharing in both directions with
  a per-run nonce.

See the [pattern doc](../../docs/patterns/shared-sandbox.md) for the guide.

## Run

Requires Vercel credentials (the backend creates real hosted sandboxes,
including from local dev).

```sh
pnpm install
pnpm --filter eve-example-shared-sandbox eval
```
