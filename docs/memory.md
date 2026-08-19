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

Each slot combines a provider with a required trusted scope, an optional namespace, and an optional model-facing description:

```ts title="agent/memory/user.ts"
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import { userMemory } from "../lib/user-memory";

export default defineMemory({
  description: "Personal preferences and durable facts for the authenticated user.",
  provider: userMemory,
  scope: byPrincipal,
});
```

Passing `byPrincipal` as the resolver partitions the provider by the authenticated caller. Its value includes the principal type, authenticator, optional issuer, and principal ID. It resolves `null` for an unauthenticated turn, an anonymous principal such as `none()` traffic, and a runtime principal such as a scheduled turn, so eve does not call the provider, expose its tools, or include the slot's recalled messages. Local development authenticates every request as the shared `local-dev` principal, so one development machine resolves one scope.

Pass `byPrincipal` by reference, as shown above. eve supplies its scope context when it locks the operation. Inside a custom scope resolver, call `byPrincipal(ctx)` with that same context.

Namespace accepts a string, `null`, or a resolver that receives the slot's deployment coordinates. Scope accepts the same direct string and `null` forms, but its resolver receives trusted request context:

```ts
interface MemoryNamespaceContext {
  appRoot: string;
  node: string;
  slot: string;
}

type MemoryNamespaceDefinition =
  string | null | ((ctx: MemoryNamespaceContext) => string | null | Promise<string | null>);

type MemoryScopeResolverResult = string | readonly string[] | null;

type MemoryScopeDefinition =
  | string
  | null
  | ((ctx: MemoryScopeContext) => MemoryScopeResolverResult | Promise<MemoryScopeResolverResult>);
```

`MemoryScopeContext` contains `abortSignal`, `session.id`, `session.auth`, and the active channel's `kind`, `continuationToken`, and projected `metadata`. It deliberately excludes messages and turn input. A resolver may be synchronous or asynchronous. eve invokes it once when locking the turn or standalone operation.

Returning an array is a convenience for `components.join(":")`. The array and every component must be non-empty. It is not a structured or collision-resistant tuple encoding, so return your own canonical string when components may contain `:`.

Resolvers may be synchronous or asynchronous, and eve invokes them when it locks the operation, not when the authored module is evaluated.

If either field resolves to `null`, eve disables the slot for that operation: it does not call the provider, expose its tools, or include its recalled messages.

If you omit `namespace`, eve uses the exported `defaultNamespace` function as the resolver. It derives a deployment-aware value from the Vercel project when available, otherwise a hash of the application root, plus the environment and the node and slot from the supplied context. It is a pure function of that context and the deployment environment, so a custom resolver can compose with it:

```ts
import { defaultNamespace, defineMemory } from "eve/memory";

export default defineMemory({
  namespace: (ctx) => `${defaultNamespace(ctx)}:${process.env.DEPLOYMENT_REGION ?? "local"}`,
  // ...
});
```

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

Custom namespaces replace the default completely. eve does not append the application root, environment, graph node, or slot. This also means two definitions with the same custom namespace and scope intentionally share the same provider partition.

Do not derive scope from model input or unattested message fields. eve derives a collision-resistant `ctx.memory.scope.key` from exactly the resolved namespace and scope. Providers can also inspect the original values as `ctx.memory.scope.namespace` and `ctx.memory.scope.value`.

`byPrincipal` follows the same authenticated principal across every channel. If a slot stores channel- or conversation-private data, include trusted channel coordinates in its scope. Use `isChannel` to narrow metadata from an authored channel:

```ts title="agent/memory/slack.ts"
import { isChannel } from "eve/channels";
import { defineMemory } from "eve/memory";
import { byPrincipal } from "eve/memory/scope";
import slack from "../channels/slack";
import { channelMemory } from "../lib/channel-memory";

export default defineMemory({
  description: "Shared conventions for this Slack channel.",
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

## Describe provider tools

Set `description` when a provider exposes tools and the model needs to distinguish the slot from other memory destinations. The description is a static string owned by the consuming definition, so the same provider can serve slots with different purposes. An empty or whitespace-only description is invalid.

eve prepends the slot description and two newline characters to every tool description returned by the provider. For example, the `user__forget` tool from the first definition begins with:

```text
Personal preferences and durable facts for the authenticated user.

Forget one saved memory.
```

Without `description`, eve preserves the provider's tool descriptions unchanged. The description is not added to recalled messages or inserted into the prompt separately, so it has no model-facing effect when the provider exposes no tools. eve never derives it from the slot name, namespace, scope, or request context.

Descriptions help the model choose among qualified memory tools; they do not grant access. Continue to enforce the data boundary with `scope`, provider authorization, and tool approval where needed.

## Use file memory

`fileMemory()` provides a bounded, model-maintained memory document for each scope. The smallest complete slot uses it with `byPrincipal`:

```ts title="agent/memory/user.ts"
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  description: "Personal preferences and durable facts for the authenticated user.",
  provider: fileMemory(),
  scope: byPrincipal,
});
```

The provider reads the current document at every turn start and after each successful compaction. It appends the formatted document when durable history does not already contain an identical latest recall for the same slot and scope; an empty or unchanged document appends nothing. It exposes `save_memory({ text })` and `remove_memory({ index })`, which eve qualifies with the slot name as `user__save_memory` and `user__remove_memory`. It does not implement `save`, run a hidden capture model, or persist complete transcripts. The model decides when to maintain the document by calling its tools.

The document stores one memory per line. Recall includes each stable index so the model can remove an entry without rewriting unrelated memories:

```text
0: Prefers dark mode.
1: Likes concise answers.
```

New memories receive an index above the current highest index. Saving normalizes whitespace, and saving the same text again returns its existing index. Removing a missing index does nothing. Conditional writes preserve concurrent changes, and surviving entries keep their indexes.

The default limit is 100 entries. Set `maxEntries` to another positive integer when you need a different bound. At the limit, the model must remove an outdated entry before saving another.

Outside Vercel, `fileMemory()` defaults to process-local storage in non-production environments. That storage is not durable or shared across instances; import `inMemory()` from `eve/memory/file` when you want to select it explicitly in a test. On Vercel, the provider uses private Vercel Blob storage when the deployment has an attached Blob store. It fails on its first storage operation if no store is attached. A production deployment outside Vercel must pass an explicit backend.

You can also select Vercel Blob explicitly:

```ts title="agent/memory/user.ts"
import { defineMemory } from "eve/memory";
import { fileMemory } from "eve/memory/file";
import { vercelBlob } from "eve/memory/file/vercel";
import { byPrincipal } from "eve/memory/scope";

export default defineMemory({
  description: "Personal preferences and durable facts for the authenticated user.",
  provider: fileMemory({
    backend: vercelBlob({
      prefix: "my-agent/memory",
      token: process.env.BLOB_READ_WRITE_TOKEN,
    }),
    maxEntries: 200,
  }),
  scope: byPrincipal,
});
```

For another store, implement `MemoryDocumentBackend` from `eve/memory/file`. It is an optimistic read-and-replace contract for one versioned text document. A stale write must throw `MemoryDocumentConflictError`; `fileMemory()` then reloads the document and reapplies the individual save or remove operation.

## Control recall visibility

A non-empty recall result appends a scope-attributed message to durable history. The optional `visibility` field controls which earlier recalled messages enter a model request when the slot resolves a different scope:

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

| Value               | Context included after a scope change                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"scope"` (default) | Only recalled messages whose slot and scope key match the active turn. Earlier participants' recalled messages are filtered from the model request. |
| `"session"`         | Every recalled message for the slot stays visible in durable-history order. Use this only when all scopes in the session form one trusted audience. |

Filtering an earlier recalled message changes the existing prompt prefix and may invalidate the affected prompt cache. Under `"session"` visibility, earlier messages stay in place and later recall results only extend history. This mode intentionally shares recalled content across scopes.

Visibility changes only attributed recall messages in model requests. It does not remove ordinary user, assistant, or tool messages from durable history, and it cannot undo information already reflected in an assistant response. Use separate sessions when participants require hard isolation.

## Define a provider

A provider implements required `recall` behavior and may add `capture` and `tools`:

```ts title="agent/lib/user-memory.ts"
import { defineMemoryProvider, getMemoryMessageAttribution } from "eve/memory";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { service } from "./service";

export const userMemory = defineMemoryProvider({
  async recall(ctx) {
    const content = await service.recall({
      history: ctx.messages,
      input: ctx.turn?.input ?? [],
      scope: ctx.memory.scope,
      signal: ctx.abortSignal,
    });

    if (content === null) return;

    const latest = ctx.messages.findLast((message) => {
      const attribution = getMemoryMessageAttribution(message);
      return (
        attribution?.slot === ctx.memory.slot && attribution.scope.key === ctx.memory.scope.key
      );
    });

    return latest?.content === content ? undefined : { content, role: "user" };
  },

  async capture(ctx) {
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

`defineMemoryProvider(...)` is an identity helper that supplies the provider types. It does not add storage behavior or impose a record model. The same provider instance can back multiple slots; eve keeps their recalled messages, tools, and lifecycle calls independent. Default namespaces isolate provider scope keys by slot. Custom namespaces can intentionally share a scope key.

Every recall and capture call receives:

- `ctx.memory.scope`, the active trusted partition.
- `ctx.memory.slot`, the path-derived slot name.
- `ctx.messages`, durable model history at the boundary, including prior recalled messages.
- `ctx.operationId`, the identifier for one logical recall or capture operation. eve reuses it across workflow replay.
- `ctx.abortSignal` and the read-only session context.

Turn-aware calls also receive a stable turn ID, a zero-based sequence, and normalized turn input. Compaction calls include the compaction model ID and, before compaction, input-token usage when available.

The `tools` function receives the standard dynamic resolver context: `ctx.session`, `ctx.channel`, and `ctx.messages`. It also receives `ctx.memory` and `ctx.turn`. It does not receive an operation ID or step coordinates because eve resolves it once per turn.

## Recall model context

eve calls `recall` when a turn starts and after a successful compaction. Inspect `ctx.phase` to distinguish the two calls:

- `"turn.started"` includes the current `ctx.turn.input`. The first durable turn has `ctx.turn.sequence === 0`.
- `"compaction.completed"` includes the settled post-compaction history. `ctx.turn` is `null` for standalone manual compaction.

The recall result is append-only:

| Result                                           | Effect                                                                            |
| ------------------------------------------------ | --------------------------------------------------------------------------------- |
| `{ content: string, role?: "system" \| "user" }` | Append one scope-attributed message with the resolved role. Defaults to `"user"`. |
| `null`, `undefined`, or no return                | Append nothing at this boundary.                                                  |
| A result whose content is empty after trimming   | Append nothing at this boundary.                                                  |

eve trims recall content using the same normalization as instructions. A recall result never replaces, clears, or mutates an earlier message. Providers own repetition and correction policy: returning the same snapshot again appends a duplicate, while returning `null` leaves existing history unchanged.

A user-role recall enters model context in its durable history position. A system-role recall keeps the same durable position and attribution but joins the system prompt at model assembly, like a system-role instruction. Because changed system-prompt content invalidates the cached prompt prefix, prefer the default user role for frequently changing context.

A provider can recall on every turn, only when `ctx.turn.sequence === 0`, or only when its latest stored context is absent from history. Use `getMemoryMessageAttribution(message)` to identify recalled messages by slot and scope without relying on eve's internal metadata representation.

Turn-start recall messages are appended immediately before the admitted turn input. Post-compaction recall messages are appended after the rewritten checkpoint and retained tail. Multiple slots append in stable slot order. Recall messages are not emitted as `message.received`, but they otherwise follow the ordinary durable-history lifecycle: they appear in `ctx.messages` and completed-turn captures, and compaction may summarize or discard them.

Before compaction, eve applies the active visibility policy. Scope-hidden recall cannot enter the checkpoint and is removed with the rewritten history. After compaction, eve invokes `recall({ phase: "compaction.completed" })`, allowing the provider to append fresh context when the rewritten history no longer contains it.

Like [instructions](./instructions), recalled context uses ordinary durable messages and preserves the normal prompt prefix when appended. Memory adds provider lifecycle boundaries, slot-and-scope attribution, and cross-scope visibility filtering.

## Capture durable history

If the provider implements `capture`, eve calls it at two boundaries:

- `"compaction.requested"` receives the complete durable history before compaction rewrites it. A failure aborts compaction before history changes.
- `"turn.completed"` receives the settled history, including the assistant response and tool results. It does not run for failed, cancelled, input-deferred, or adapter-consumed turns.

Use `ctx.operationId` as the idempotency key for externally visible capture side effects. It identifies the logical slot operation and may be delivered more than once across workflow replay.

eve awaits a completed-turn capture before the next ready boundary. If it fails, eve emits a content-free diagnostic and continues because the completed response cannot be rewritten.

## Provide scope-bound tools

If the provider implements `tools`, eve resolves it once after turn-start recall. The function may be synchronous or asynchronous. Return a record of ordinary `defineTool(...)` definitions, or return `null` or an empty record to expose no tools for the slot during that turn.

Memory tools use the same implementation as a `turn.started` [`defineDynamic`](./guides/dynamic-capabilities#dynamic-tools) tool resolver. The dynamic tool engine captures schemas and executor closures, stores serializable metadata, and reconstructs the tools for every model step without calling the provider again.

eve qualifies each returned key with the slot name. The `forget` tool above becomes `user__forget` when mounted at `agent/memory/user.ts`. The model receives neither the slot nor the scope as tool input. Provider tools otherwise use the standard tool contract, including schemas, authorization, approval, and model-output projection.

When the consuming `defineMemory(...)` includes `description`, eve prepends it to every returned tool description before storing the turn's durable dynamic metadata. Every model step and parked continuation therefore sees the same slot-specific description.

Approval helpers keep their standard semantics. In particular, `once()` approves a qualified tool name for the entire session, so that approval also applies after the memory scope changes. Use `always()` or a custom approval policy when an operation needs participant- or scope-specific approval.

A call that parks for approval or authorization retains its resolved dynamic metadata. eve reconstructs the exact originating definition, including its captured scope, even if another participant has since replaced the current turn's tools. It does not call the provider's `tools` function again or substitute the current scope.

A direct inline-authorization park follows the standard tool behavior. Its unfinished assistant/tool exchange does not enter durable history, and the callback makes the credential available only to its matching principal. It does not replay the original execution. Later model steps in the turn use the same captured tool set.

Write each `execute` as an inline function expression, arrow, or method shorthand inside `defineTool(...)`, just as you would for any durable dynamic tool. Perform provider mutations in `execute`, not while resolving the tool set. A throwing or invalid `tools` result is diagnosed and omitted for that turn, matching ordinary dynamic tool resolution.

## Lifecycle and failure behavior

| Boundary               | Provider call                                | Failure behavior                                                                              |
| ---------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Turn start             | `recall({ phase: "turn.started" })`          | Fails the turn before the model runs.                                                         |
| After turn recall      | `tools(ctx)`                                 | Diagnoses an invalid or throwing resolver and omits its tools for the turn.                   |
| Before compaction      | `capture({ phase: "compaction.requested" })` | Aborts compaction before history changes.                                                     |
| After compaction       | `recall({ phase: "compaction.completed" })`  | Fails an automatically compacting turn; a standalone compaction emits a diagnostic and waits. |
| After a completed turn | `capture({ phase: "turn.completed" })`       | Emits a content-free diagnostic and continues to the ready boundary.                          |

Providers must apply `ctx.memory.scope.key` or both `ctx.memory.scope.namespace` and `ctx.memory.scope.value` to every downstream read and write. eve supplies no unscoped provider invocation path, but it cannot prevent provider code from ignoring the supplied scope.

## Package a provider

A provider package can export a `MemoryProvider` or a provider factory with its own credentials, storage, migrations, retrieval, capture, and tools. The consuming agent still declares `defineMemory(...)` with its model-facing description, namespace, scope, and visibility policy. Extensions cannot contribute memory slots because those purpose, audience, and partition choices belong to the consuming application.
