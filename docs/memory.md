---
title: "Memory"
description: "Define scoped memory providers and control which recalled context enters model calls."
---

Memory is a path-authored capability for scoped context that outlives one session. Your provider owns storage, retrieval, formatting, retention, and model-facing operations. eve owns when the provider runs, how its namespace and trusted scope resolve, where recalled context enters the prompt, and which provider tools the model can call.

Create one flat slot or a directory of named slots:

```text
agent/memory.ts

# or
agent/memory/
├── user.ts
└── workspace.ts
```

The two forms are mutually exclusive. The file path determines the slot name: `agent/memory.ts` creates `memory`, while `agent/memory/user.ts` creates `user`. Local subagents can declare their own slots and do not inherit memory from their parent.

## Define a memory slot

Each slot combines a provider with a required trusted scope and an optional namespace:

```ts title="agent/memory/user.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { userMemory } from "../lib/user-memory";

export default defineMemory({
  provider: userMemory,
  scope: byPrincipal,
});
```

Passing `byPrincipal` as the resolver partitions the provider by the authenticated caller. Its value includes the principal type, authenticator, optional issuer, and principal ID. An unauthenticated turn resolves to `null`, so eve does not call the provider, expose its tools, or include the slot's projections.

Pass `byPrincipal` by reference, as shown above. eve supplies its scope context when it locks the operation. Inside a custom scope resolver, call `byPrincipal(ctx)` with that same context.

Namespace accepts a string, `null`, a promise, or a zero-argument resolver. Scope accepts the same direct string, `null`, and promise forms, but its resolver receives trusted request context:

```ts
type MemoryNamespaceDefinition =
  string | null | Promise<string | null> | (() => string | null | Promise<string | null>);

type MemoryScopeResolverResult = string | readonly string[] | null;

type MemoryScopeDefinition =
  | string
  | null
  | Promise<string | null>
  | ((ctx: MemoryScopeContext) => MemoryScopeResolverResult | Promise<MemoryScopeResolverResult>);
```

`MemoryScopeContext` contains `abortSignal`, `session.id`, `session.auth`, and the active channel's `kind`, `continuationToken`, and projected `metadata`. It deliberately excludes messages and turn input. A resolver may be synchronous or asynchronous. eve invokes it once when locking the turn or standalone operation.

Returning an array is a convenience for `components.join(":")`. The array and every component must be non-empty. It is not a structured or collision-resistant tuple encoding, so return your own canonical string when components may contain `:`.

Use a resolver for work that should begin when eve locks the operation. A direct promise starts eagerly when the authored module is evaluated. Calling `defaultNamespace()` during module evaluation fails because its path and deployment context are available only during namespace resolution.

If either field resolves to `null`, eve disables the slot for that operation: it does not call the provider, expose its tools, or include its projections.

If you omit `namespace`, eve uses the exported `defaultNamespace` function. It resolves a deployment-aware value from the Vercel project when available, otherwise the local application root, plus the environment, graph node, and path-derived slot.

Set `namespace` when you need complete control over the provider's application domain:

```ts title="agent/memory/workspace.ts"
import { defineMemory } from "eve/memory";
import { workspaceMemory } from "../lib/workspace-memory";

export default defineMemory({
  namespace: "acme:production:workspace-memory",
  provider: workspaceMemory,
  scope: "workspace:product-docs",
});
```

Custom namespaces replace the default completely. eve does not append the application root, environment, graph node, or slot. This also means two definitions with the same custom namespace and scope intentionally address the same provider partition.

Do not derive scope from model input or unattested message fields. eve derives a collision-resistant `ctx.memory.scope.key` from exactly the resolved namespace and scope. Providers can also inspect the original values as `ctx.memory.scope.namespace` and `ctx.memory.scope.value`.

`byPrincipal` follows the same authenticated principal across every channel. If a slot stores channel- or conversation-private data, include trusted channel coordinates in its scope. Use `isChannel` to narrow metadata from an authored channel:

```ts title="agent/memory/slack.ts"
import { isChannel } from "eve/channels";
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import slack from "../channels/slack";
import { channelMemory } from "../lib/channel-memory";

export default defineMemory({
  provider: channelMemory,
  scope: (ctx) => {
    if (!isChannel(ctx.channel, slack)) return null;

    const principal = byPrincipal(ctx);
    const { channelId, teamId } = ctx.channel.metadata;
    return principal === null || channelId === null || teamId === null
      ? null
      : [principal, teamId, channelId];
  },
});
```

The array resolves to `<principal>:<teamId>:<channelId>`. Add the channel's thread or conversation identifier when memory must not cross that boundary. Returning `null` disables this Slack-only slot for other channels or before Slack has supplied the required metadata.

eve locks the resolved scope through the active turn, including model steps and durable approved-call continuations. A standalone manual compaction resolves and locks a scope for that operation. Provider tools close over the same scope, so the model never chooses a user, tenant, or container.

## Control projection visibility

A recall produces a scope-bound projection that eve keeps separate from ordinary conversation history. The optional `visibility` field controls what happens to prior projections when the slot resolves a different scope:

```ts title="agent/memory/user.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { userMemory } from "../lib/user-memory";

export default defineMemory({
  provider: userMemory,
  scope: byPrincipal,
  visibility: "session",
});
```

| Value               | Context included after a scope change                                                                                                           |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `"scope"` (default) | Only the projection whose scope key matches the active turn. Projections recalled for earlier participants are filtered from the request.       |
| `"session"`         | Every projection recalled for the slot remains visible in anchor order. Use this only when all scopes in the session form one trusted audience. |

Filtering an earlier projection changes the existing prompt prefix and may invalidate the affected prompt cache. A scope change by itself preserves that prefix under `"session"` visibility, but replacing or clearing a projection may still invalidate it. This mode intentionally shares recalled content across scopes.

Visibility changes only memory projections. It does not remove ordinary user, assistant, or tool messages, and it cannot undo information already reflected in an assistant response. Use separate sessions when participants require hard isolation.

## Define a provider

A provider implements required `recall` behavior and may add `save` and `tools`:

```ts title="agent/lib/user-memory.ts"
import { defineMemoryProvider } from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { service } from "./service";

export const userMemory = defineMemoryProvider({
  async recall(ctx) {
    if (ctx.phase === "turn.started" && ctx.turn.sequence > 0 && ctx.memory.current !== null) {
      return;
    }

    const content = await service.recall({
      history: ctx.messages,
      input: ctx.turn?.input ?? [],
      scope: ctx.memory.scope,
      signal: ctx.abortSignal,
    });

    return content === null || content.length === 0 ? null : { content };
  },

  async save(ctx) {
    if (ctx.phase === "compaction.requested") {
      await service.checkpoint({
        history: ctx.messages,
        operationId: ctx.operationId,
        scope: ctx.memory.scope,
        signal: ctx.abortSignal,
      });
      return;
    }

    await service.capture({
      history: ctx.messages,
      operationId: ctx.operationId,
      scope: ctx.memory.scope,
      signal: ctx.abortSignal,
      turn: ctx.turn,
    });
  },

  async tools(ctx) {
    const policy = await service.toolPolicy(ctx.session.auth.current);
    const scope = ctx.memory.scope;

    return {
      forget: defineTool({
        description: "Forget one saved memory.",
        inputSchema: z.object({ id: z.string() }),
        execute: ({ id }, toolCtx) =>
          service.forget({
            id,
            policy,
            scope,
            signal: toolCtx.abortSignal,
          }),
      }),
    };
  },
});
```

`defineMemoryProvider(...)` is an identity helper that supplies the provider types. It does not add storage behavior or impose a record model. The same provider instance can back multiple slots; eve keeps their projections, tools, and lifecycle calls independent. Default namespaces isolate provider addresses by slot. Custom namespaces can intentionally share an address.

Every recall and save call receives:

- `ctx.memory.scope`, the active trusted partition.
- `ctx.memory.slot`, the path-derived slot name.
- `ctx.memory.current`, the current projection for this slot and scope, or `null`.
- `ctx.messages`, durable model history at the boundary, excluding memory projections.
- `ctx.operationId`, the identifier for one logical recall or save operation. eve reuses it across workflow replay.
- `ctx.abortSignal` and the read-only session context.

Turn-aware calls also receive a stable turn ID, a zero-based sequence, and normalized turn input. Compaction calls include the compaction model ID and, before compaction, input-token usage when available.

The `tools` function receives the standard dynamic resolver context: `ctx.session`, `ctx.channel`, and `ctx.messages`. It also receives `ctx.memory` and `ctx.turn`. It does not receive an operation ID or step coordinates because eve resolves it once per turn.

## Recall model context

eve calls `recall` when a turn starts and after a successful compaction. Inspect `ctx.phase` to distinguish the two calls:

- `"turn.started"` includes the current `ctx.turn.input`. The first durable turn has `ctx.turn.sequence === 0`.
- `"compaction.completed"` includes the settled post-compaction history. `ctx.turn` is `null` for standalone manual compaction.

The recall result updates only the active scope's projection:

| Result                          | Effect                                                  |
| ------------------------------- | ------------------------------------------------------- |
| `{ content: non-empty string }` | Replace the current projection for this slot and scope. |
| `null`                          | Clear the current projection for this slot and scope.   |
| `undefined` / no return         | Preserve the current projection without changing it.    |

Projection content must contain at least one character. An empty string is invalid and fails the recall at that lifecycle boundary; it does not mean clear or skip. Return `null` to clear the projection or `undefined` to preserve it.

A provider can recall on every turn, only when `ctx.turn.sequence === 0`, or whenever `ctx.memory.current === null`. eve still calls the method at each fixed boundary so the provider owns that choice.

The first valid projection for a scope anchors a synthetic user-role message immediately before that scope's current turn input. Later recall results replace or clear the projection at the same anchor. Projections are not emitted as ordinary messages, included in compaction input, or returned through `ctx.messages`. After compaction, eve reanchors the visible projections around the new checkpoint before applying the post-compaction recall result.

This differs from [user-role instructions](./instructions). Instructions append application context to durable conversation history. A memory projection is replaceable provider context that remains attributed to its slot and scope.

## Save durable history

If the provider implements `save`, eve calls it at two boundaries:

- `"compaction.requested"` receives the complete durable history before compaction rewrites it. A failure aborts compaction before history changes.
- `"turn.completed"` receives the settled history, including the assistant response and tool results. It does not run for failed, cancelled, input-deferred, or adapter-consumed turns.

Use `ctx.operationId` as the idempotency key for externally visible save side effects. It identifies the logical slot operation and may be delivered more than once across workflow replay.

eve awaits a completed-turn save before the next ready boundary. If it fails, eve emits a content-free diagnostic and continues because the completed response cannot be rewritten.

## Provide scope-bound tools

If the provider implements `tools`, eve resolves it once after turn-start recall. The function may be synchronous or asynchronous. Return a record of ordinary `defineTool(...)` definitions, or return `null` or an empty record to expose no tools for the slot during that turn.

Memory tools use the same implementation as a `turn.started` [`defineDynamic`](./guides/dynamic-capabilities#dynamic-tools) tool resolver. The dynamic tool engine captures schemas and executor closures, stores serializable metadata, and reconstructs the tools for every model step without calling the provider again.

eve qualifies each returned key with the slot name. The `forget` tool above becomes `user__forget` when mounted at `agent/memory/user.ts`. The model receives neither the slot nor the scope as tool input. Provider tools otherwise use the standard tool contract, including schemas, authorization, approval, and model-output projection.

Approval helpers keep their standard semantics. In particular, `once()` approves a qualified tool name for the entire session, so that approval also applies after the memory scope changes. Use `always()` or a custom approval policy when an operation needs participant- or scope-specific approval.

A call that parks for approval or authorization retains its resolved dynamic metadata. eve reconstructs the exact originating definition, including its captured scope, even if another participant has since replaced the current turn's tools. It does not call the provider's `tools` function again or substitute the current scope.

A direct inline-authorization park follows the standard tool behavior. Its unfinished assistant/tool exchange does not enter durable history, and the callback makes the credential available only to its matching principal. It does not replay the original execution. Later model steps in the turn use the same captured tool set.

Write each `execute` as an inline function expression, arrow, or method shorthand inside `defineTool(...)`, just as you would for any durable dynamic tool. Perform provider mutations in `execute`, not while resolving the tool set. A throwing or invalid `tools` result is diagnosed and omitted for that turn, matching ordinary dynamic tool resolution.

## Lifecycle and failure behavior

| Boundary               | Provider call                               | Failure behavior                                                                              |
| ---------------------- | ------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Turn start             | `recall({ phase: "turn.started" })`         | Fails the turn before the model runs.                                                         |
| After turn recall      | `tools(ctx)`                                | Diagnoses an invalid or throwing resolver and omits its tools for the turn.                   |
| Before compaction      | `save({ phase: "compaction.requested" })`   | Aborts compaction before history changes.                                                     |
| After compaction       | `recall({ phase: "compaction.completed" })` | Fails an automatically compacting turn; a standalone compaction emits a diagnostic and waits. |
| After a completed turn | `save({ phase: "turn.completed" })`         | Emits a content-free diagnostic and continues to the ready boundary.                          |

Providers must apply `ctx.memory.scope.key` or both `ctx.memory.scope.namespace` and `ctx.memory.scope.value` to every downstream read and write. eve supplies no unscoped provider invocation path, but it cannot prevent provider code from ignoring the supplied scope.

## Package a provider

A provider package can export a `MemoryProvider` or a provider factory with its own credentials, storage, migrations, retrieval, capture, and tools. The consuming agent still declares `defineMemory(...)` with its namespace, scope, and visibility policy. Extensions cannot contribute memory slots because those audience and partition choices belong to the consuming application.
