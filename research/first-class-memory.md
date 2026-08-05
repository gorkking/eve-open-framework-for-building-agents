---
issue: https://github.com/vercel/eve/issues/1510
status: proposed
last_updated: "2026-08-05"
---

# First-class memory

## Proposal

Memory is a path-authored slot that lets an agent carry provider-defined context and behavior across sessions. Its presence in the agent filesystem makes memory an explicit framework capability without requiring eve to define what a memory is or how one works.

eve owns only two pieces:

1. **Authored identity.** Each memory file is a named slot with path-derived identity.
2. **Scope.** eve resolves and locks a trusted partition for that slot, then supplies the same partition to every provider hook and provider-defined tool in the turn.

The provider owns everything else: storage, recall, capture, model tools, formatting, extraction, ranking, limits, retention, and any record or document model. A hosted semantic service and a pair of bounded text files can therefore implement the same memory slot without pretending to share lower-level semantics.

```text
turn start       eve scope + visible session ---> provider recall ---> transient context
                 eve scope + visible session ---> provider tools  ---> scoped model tools
turn completed   eve scope + settled session ---> provider capture
```

This document defines that authoring boundary and its observable lifecycle. Provider packaging, vendor configuration, and provider-specific persistence remain follow-up work.

## Authoring experience

An agent may declare one flat memory slot or a directory of named slots:

```text
agent/memory.ts            # one slot named "memory"
agent/memory/              # XOR with the flat file
  user.ts                  # slot named "user"
  workspace.ts             # slot named "workspace"
```

Each module default-exports `defineMemory(...)`. Identity comes from the path rather than a `name` field. A slot configures only its provider and scope:

```ts title="agent/memory/user.ts"
import { byPrincipal, defineMemory } from "eve/memory";
import { memory } from "../lib/memory";

export default defineMemory({
  provider: memory,
  scope: byPrincipal(),
});
```

`provider` supplies the memory behavior. `scope` resolves the provider partition for the current turn. Descriptions, prompts, tool policy, and storage options belong to provider configuration rather than `defineMemory`.

The same provider instance may back several slots. For example, `user.ts` may resolve `[userId]` while `workspace.ts` resolves `[workspaceId]`. Their path identities, scope keys, recalled context, tools, and capture invocations remain separate.

Local directory-form subagents may declare their own memory slots. Graph-node identity keeps root and subagent slots isolated even when they use the same path, scope parts, and provider.

## Scope

The low-level scope definition returns one ordered tuple of opaque, trusted identifiers or `null`:

```ts
type MemoryScopeDefinition = (context: MemoryScopeContext) => readonly MemoryScopePart[] | null;
```

Scope parts come from trusted auth, application, or channel context. They cannot come from model input or unattested message fields. Parts have no built-in entity types, and no position has special meaning. `[userId, channelId]` means only that both values participate in the provider partition. `byPrincipal()` is sugar for the common authenticated-principal tuple.

For each resolved slot, eve creates this scope value:

```ts
interface MemoryScope {
  /** Stable eve namespace derived from application, environment, graph node, slot, and parts. */
  readonly key: string;
  /** The ordered values returned by the authored scope definition. */
  readonly parts: readonly MemoryScopePart[];
}
```

The key gives providers one collision-resistant partition identifier. The parts remain available when a vendor needs to map the partition onto its own user, workspace, or container concepts. Both are absent from model-facing schemas.

eve resolves scope after admitting the turn and locks it through capture. Returning `null` makes the slot unavailable for that turn: eve does not invoke its provider hooks or lower its tools. Missing values never fall back to a broader partition. Changing the meaning or order of scope parts is a provider data migration.

eve guarantees that every invocation for one slot receives the same locked value. The provider is responsible for actually applying that value to downstream storage and service calls; eve cannot enforce isolation inside provider code or an external service.

## Provider contract

`MemoryProvider` is a public extension point with three semantic hooks. This is the intended shape; exact callback-context and tool-definition type names will be fixed by the implementation plan:

```ts
import type { ModelMessage } from "ai";
import type { ToolDefinition } from "eve/tools";

interface MemoryProviderInvocation {
  /** Path-derived slot identity, such as "memory" or "user". */
  readonly slot: string;
  readonly scope: MemoryScope;
  readonly session: {
    readonly id: string;
    /** Current ModelMessage history selected for this lifecycle point. */
    readonly messages: readonly ModelMessage[];
  };
  readonly abortSignal: AbortSignal;
}

type MemoryProviderTools = Readonly<Record<string, ToolDefinition>>;

interface MemoryProvider {
  recall?(input: MemoryProviderInvocation, context: MemoryCallbackContext): Promise<string | null>;

  tools?(
    input: MemoryProviderInvocation,
    context: MemoryCallbackContext,
  ): Promise<MemoryProviderTools | null>;

  capture?(input: MemoryProviderInvocation, context: MemoryCallbackContext): Promise<void>;
}
```

Hooks are independently optional. A provider may contribute only context, only tools, only capture, or any combination. eve does not infer missing behavior or add default tools.

Every hook also receives the ordinary authored callback context for session, auth, channel, and runtime access. The invocation carries the memory-specific slot, scope, message history, and cancellation signal explicitly so provider behavior does not depend on ambient model input.

`defineMemoryProvider(...)` validates and brands a custom implementation but does not implement storage or impose a data model:

```ts title="agent/lib/memory.ts"
import { defineMemoryProvider } from "eve/memory";
import { service } from "./service";

export const memory = defineMemoryProvider({
  async recall(input) {
    return await service.recall(input.scope, input.session.messages);
  },
  async tools(input) {
    return service.toolsFor(input.scope);
  },
  async capture(input) {
    await service.capture(input.scope, input.session.messages);
  },
});
```

The provider decides what each hook means. `recall` need not search, `capture` need not run a model, and tools need not manipulate memory.

## Lifecycle

### Turn start

After turn admission and compaction, eve resolves each slot's scope and invokes its `recall` and `tools` hooks once. Their session history includes the newest admitted input and every model-visible user, assistant, and tool message retained after compaction.

A non-empty `recall` result becomes one transient user-context message appended at the prompt tail. Results from several slots appear in stable slot-path order. Providers own all formatting and attribution within their returned text.

Recalled context is not a system instruction. Keeping it at the prompt tail leaves authored instructions and the prior conversation prefix stable for prompt caching. It also remains transient: eve does not write it to durable session history, include it in later capture input, or restore it on replay as conversation authored by the user.

Provider tools are available for every model step in the turn. A provider returns tool keys such as `forget` or `propose`; eve lowers them as `<memory-slot>__<provider-tool>`, for example `user__forget`. Qualification is unconditional, so adding another memory slot never renames an existing tool or creates a collision when two slots use the same provider.

The model never supplies slot identity or scope. eve binds the resolved invocation to each lowered executor, and provider code uses that bound scope for its service or storage call. Provider tools otherwise use the ordinary tool contract, including schemas, approvals, results, and authorization access. A provider may expose tools unrelated to conventional memory CRUD.

### Turn completion

After `turn.completed`, eve invokes `capture` for every slot that resolved at turn start. The hook receives the same locked scope and the complete settled durable model history, including assistant tool calls and tool results. It does not receive transient recalled context.

eve awaits capture before emitting `session.waiting` in conversation mode or `session.completed` in task mode. A caller that starts the next turn after the ready boundary therefore observes settled provider state. Capture does not run for failed, cancelled, abandoned, deferred, or adapter-consumed turns, nor for manual clear or compaction boundaries that did not complete a turn.

The provider decides whether capture stores the whole session, extracts selected details, rewrites a document, queues its own downstream work, or does nothing. eve does not run a capture model or inspect what the provider persists.

### Failures

A `recall` or `tools` failure fails the turn. Memory is an authored capability, so silently running with a different prompt or tool set would violate the agent definition.

A `capture` failure occurs after the response and cannot change that completed response. eve emits content-free diagnostics and continues to `session.waiting` or `session.completed`. Providers that acknowledge capture before their own asynchronous persistence completes own the resulting eventual consistency and retry behavior.

## Reference providers

V1 includes two reference providers to prove that the framework boundary does not encode one memory architecture. Package names, credentials, deployment configuration, and service-specific controls belong in provider-specific plans.

### Supermemory

The Supermemory provider sends the resolved scope and visible session history to Supermemory during recall. Supermemory decides what is relevant and returns the fully formatted text that eve injects. eve does not understand Supermemory profiles, containers, documents, search, or extraction.

The provider chooses its tool set. It may expose scoped search, save, forget, profile, or proposal tools, or another capability entirely. eve only qualifies and scope-binds the returned definitions.

After a completed turn, the provider sends the settled session to Supermemory. Supermemory decides what to persist and how to update its own memory representation. eve does not translate the session into framework records or validate the resulting writes.

### Blob documents

The blob provider stores bounded `USER.md`- and `MEMORY.md`-style text documents under the resolved scope. Recall reads the documents and returns their provider-formatted contents directly; it requires no search, embeddings, or record schema.

The provider owns any tools for editing, consolidating, or clearing those documents. Its capture hook may rewrite them from the completed session and enforce provider-configured size limits. File layout, truncation or consolidation policy, concurrency, and blob-store behavior remain internal to the provider.

This provider demonstrates that simple bounded text can participate in the same lifecycle as a hosted semantic service without eve standardizing either implementation.

## Observable guarantees

- Memory slots have path-derived identity and an explicit authored scope.
- Scope is resolved from trusted runtime context, locked for the turn, and never accepted from model input.
- The same provider can back several slots without sharing eve scope keys or colliding model tools.
- Recall sees the post-compaction visible session including the newest input and contributes transient tail context in deterministic slot order.
- Provider tools are unconditionally slot-qualified and bound to the same locked scope as recall and capture.
- Capture sees the completed durable session without recalled transient context and settles before the next ready boundary.
- Recall and tool-resolution failures fail the turn; capture failures cannot rewrite the completed response or suppress the ready boundary.
- Providers, not eve, define persistence, consistency after provider acknowledgment, retention, erasure, and administrative behavior.

## Non-goals

- A framework record, revision, origin, citation, CRUD, query, ranking, embedding, vector, or canonical-storage model.
- Framework-provided recall, remember, forget, purge, export, application-write, or administrative APIs.
- A built-in capture model, extractor, formatter, token budget, retention policy, or erasure guarantee.
- Cross-provider search, mutation, record reconciliation, or behavioral conformance beyond the lifecycle contract.
- Memory without an explicit scope tuple or model-selected alternate scopes.
- Preventing a faulty or malicious provider from ignoring the supplied scope, disclosing data, or persisting unintended content.
- Standardizing provider package layout, vendor credentials, migrations, inspection tools, or deployment operations in this proposal.

## Implementation contract follow-up

Before V1 implementation lands, follow-up plans must fix the exact public type names, callback context, scope-part encoding, tool-factory and durable-replay mechanics, diagnostic events, cancellation behavior, provider packaging, and tests for lifecycle ordering and isolation. Supermemory and blob storage each need a provider-specific plan for configuration and operational behavior without expanding the core memory contract.

## Primary references

- [Supermemory: how it works](https://supermemory.ai/docs/concepts/how-it-works)
- [Hermes Agent memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)
- [eve dynamic capabilities](../docs/guides/dynamic-capabilities.md)
- [eve project layout](../docs/reference/project-layout.md)
- [eve prompt caching](../packages/eve/src/harness/prompt-cache.ts)
- [eve turn execution](../packages/eve/src/execution/workflow-steps.ts)
