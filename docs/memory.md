---
title: "Memory"
description: "Attach provider-owned context, tools, and lifecycle behavior across sessions."
---

Memory is an explicit filesystem slot that carries provider-owned behavior across sessions. eve supplies path-derived identity and a trusted, locked scope; your provider decides how recall, capture, storage, formatting, retention, and tools work.

Create either one flat slot or a directory of named slots:

```text
agent/memory.ts

# or
agent/memory/
├── user.ts
└── workspace.ts
```

The two forms are mutually exclusive. Local subagents can declare their own slots and do not inherit memory from their parent.

## Define a slot

```ts title="agent/memory/user.ts"
import { byPrincipal, defineMemory } from "eve/memory";
import { userMemory } from "../lib/user-memory";

export default defineMemory({
  provider: userMemory,
  scope: byPrincipal(),
});
```

`byPrincipal()` partitions the slot by the authenticated caller and disables it for unauthenticated turns. For another trusted partition, supply a scope resolver that returns an ordered tuple of non-empty strings or `null`:

```ts
scope(ctx) {
  const workspaceId = ctx.session.auth.current?.attributes.workspace_id;
  return typeof workspaceId === "string" ? [workspaceId] : null;
}
```

eve hashes the application, environment, graph node, slot, and tuple into `ctx.memory.scope.key`. The original tuple remains available as `ctx.memory.scope.parts`. Scope is resolved once and locked through the turn; the model never supplies either value.

If a memory tool pauses for approval, the pending call keeps its locked scope. Only the principal that initiated the call can answer the approval request; a response from another principal fails before eve resolves or executes the tool.

## Define a provider

Providers opt into only the lifecycle points they need:

```ts title="agent/lib/user-memory.ts"
import { defineMemoryProvider } from "eve/memory";
import { service } from "./service";

export const userMemory = defineMemoryProvider({
  events: {
    async "message.received"(event, ctx) {
      return service.recall(ctx.memory.scope, event.data.message, ctx.messages);
    },
    async "turn.completed"(_event, ctx) {
      await service.capture(ctx.memory.scope, ctx.messages);
    },
  },
});
```

A non-empty string returned from `turn.started` or `message.received` becomes one `role: "user"` message in durable session history. Use `turn.started` when recall does not depend on the incoming message. Use `message.received` when it does; the event contains the accepted message and structured parts.

eve appends memory messages after the turn's initial compaction decision. Later model steps and turns retain them until compaction or context clearing removes them, which keeps each request as an extension of the previous prompt for stable prompt caching. They are included in later provider snapshots, including `turn.completed`, and in later compaction input. Unlike dynamic instructions, memory messages are not hoisted into the system prompt.

## Provider tools

A provider can resolve scoped tools before each model step:

```ts
import { defineDynamic, defineMemoryProvider } from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";

export const userMemory = defineMemoryProvider({
  tools: defineDynamic({
    events: {
      "step.started"(_event, ctx) {
        const scope = ctx.memory.scope;
        return {
          forget: defineTool({
            description: "Forget a saved preference.",
            inputSchema: z.object({ key: z.string() }),
            execute: ({ key }) => service.forget(scope, key),
          }),
        };
      },
    },
  }),
});
```

eve always qualifies provider tool keys with the memory slot. `forget` from `agent/memory/user.ts` becomes `user__forget`; the model does not receive the slot or scope as input. Tools use the ordinary `defineTool` contract, including schemas, approvals, authorization, and model-output projection.

Memory tools use the same `defineDynamic` primitive and lifecycle scoping as other dynamic tools. `tools.events["step.started"]` owns that slot's tool set for the current model call. Returning `null` clears the slot's tools for that step.

## Lifecycle

| Boundary               | Provider input                             | Behavior                                                               |
| ---------------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| `turn.started`         | Durable history before the incoming input  | May return one durable user message                                    |
| `message.received`     | Accepted incoming message and history      | May return one durable user message                                    |
| `compaction.requested` | Complete durable history before compaction | Awaited before compaction; a failure aborts the pass                   |
| `compaction.completed` | Successfully checkpointed durable history  | Runs after the checkpoint; failures are logged and cannot roll it back |
| `step.started`         | Current model-visible durable history      | May replace or clear the slot's tools for that model call              |
| `turn.completed`       | Complete settled durable history           | Awaited after `turn.completed` and before the session becomes ready    |

Completed-turn handlers do not run for failed, cancelled, adapter-consumed, or input-deferred turns. A provider is responsible for persistence, retry/idempotency, retention, erasure, and applying the supplied scope to every downstream operation.

## Testing providers

Tests can use a module-local `Map` keyed by `ctx.memory.scope.key` to exercise recall and capture without a service. Treat that only as process-local test storage: it is neither durable nor shared across serverless instances. eve intentionally ships no storage provider as part of the framework contract.
