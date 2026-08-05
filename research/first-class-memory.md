---
issue: https://github.com/vercel/eve/issues/1510
status: proposed
last_updated: "2026-08-11"
---

# First-class memory

## Proposal

Memory is a path-authored slot that lets an agent carry provider-defined context and behavior across sessions. Its presence in the agent filesystem makes memory an explicit framework capability without requiring eve to define what a memory is or how one works.

eve owns only two pieces:

1. **Authored identity.** Each memory file is a named slot with path-derived identity.
2. **Scope.** eve resolves and locks a trusted partition for that slot, then supplies the same partition to every provider event handler and provider-defined tool in the lifecycle operation.

The provider owns everything else: storage, recall, capture, model tools, formatting, extraction, ranking, limits, retention, and any record or document model. A hosted semantic service and a pair of bounded text files can therefore implement the same memory slot without pretending to share lower-level semantics.

```text
compaction requested   scope + pre-session  ---> events ---> provider side effects
compaction completed   scope + post-session ---> events ---> provider side effects
turn prepared          scope + session      ---> events ---> transient context
step started           scope + session      ---> tools  ---> scoped model tools
turn completed         scope + session      ---> events ---> provider side effects
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

The same provider instance may back several slots. For example, `user.ts` may resolve `[userId]` while `workspace.ts` resolves `[workspaceId]`. Their path identities, scope keys, context contributions, tools, and event invocations remain separate.

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

eve resolves scope after admitting the turn but before any automatic compaction, then locks it through the completed-turn handler. For standalone manual compaction, eve resolves and locks scope for that operation from the session's trusted runtime context. Returning `null` makes the slot unavailable for the entire turn or manual operation: eve does not invoke its provider handlers or lower its tools. Missing values never fall back to a broader partition. Changing the meaning or order of scope parts is a provider data migration.

eve guarantees that every invocation for one slot within the turn or manual operation receives the same locked value. If a memory tool pauses for approval, eve retains that value for the pending invocation and accepts the approval response only from the principal that initiated it. A response from another principal fails before the tool is resolved or executed. The provider is responsible for actually applying the scope value to downstream storage and service calls; eve cannot enforce isolation inside provider code or an external service.

## Provider contract

`MemoryProvider` is a public extension point with separate, constrained event and tool maps. It follows the same event-keyed shape as eve's other dynamic APIs without naming or prescribing recall and capture operations. This is the intended shape; exact event and callback-context type names will be fixed by the implementation plan:

```ts
import type { ModelMessage } from "ai";
import type { ToolDefinition } from "eve/tools";

interface MemoryProviderContext extends MemoryCallbackContext {
  readonly memory: {
    /** Path-derived slot identity, such as "memory" or "user". */
    readonly slot: string;
    readonly scope: MemoryScope;
  };
  /** Current ModelMessage history selected for this lifecycle point. */
  readonly messages: readonly ModelMessage[];
  readonly abortSignal: AbortSignal;
}

interface MemoryTurnPreparedResult {
  /** Provider-formatted text appended as transient turn context. */
  readonly context?: string;
}

type MemoryProviderToolSet = Readonly<Record<string, ToolDefinition>>;

interface MemoryProviderEvents {
  readonly "compaction.requested"?: (
    event: CompactionRequestedEvent,
    context: MemoryProviderContext,
  ) => void | Promise<void>;

  readonly "compaction.completed"?: (
    event: CompactionCompletedEvent,
    context: MemoryProviderContext,
  ) => void | Promise<void>;

  readonly "turn.prepared"?: (
    event: TurnPreparedEvent,
    context: MemoryProviderContext,
  ) => MemoryTurnPreparedResult | null | Promise<MemoryTurnPreparedResult | null>;

  readonly "turn.completed"?: (
    event: TurnCompletedEvent,
    context: MemoryProviderContext,
  ) => void | Promise<void>;
}

interface MemoryProviderTools {
  readonly "step.started"?: (
    event: StepStartedEvent,
    context: MemoryProviderContext,
  ) => MemoryProviderToolSet | null | Promise<MemoryProviderToolSet | null>;
}

interface MemoryProvider {
  readonly events?: MemoryProviderEvents;
  readonly tools?: MemoryProviderTools;
}
```

Both maps and every handler within them are optional. A provider may contribute only context, only tools, only completed-turn side effects, or any combination. eve does not infer missing behavior or add default tools.

Every handler receives an ordinary typed eve event and authored callback context extended with the path-derived slot, locked scope, message snapshot, and cancellation signal. Scope does not depend on ambient model input.

`defineMemoryProvider(...)` validates and brands a custom implementation but does not implement storage or impose a data model:

```ts title="agent/lib/memory.ts"
import { defineMemoryProvider } from "eve/memory";
import { service } from "./service";

export const memory = defineMemoryProvider({
  events: {
    async "turn.prepared"(_event, ctx) {
      return {
        context: await service.recall(ctx.memory.scope, ctx.messages),
      };
    },
    async "turn.completed"(_event, ctx) {
      await service.capture(ctx.memory.scope, ctx.messages);
    },
  },
  tools: {
    async "step.started"(_event, ctx) {
      return service.toolsFor(ctx.memory.scope);
    },
  },
});
```

The provider decides what each handler means. A compaction handler need not extract, a prepared-turn handler need not search, a completed-turn handler need not persist, and tools need not manipulate memory.

## Lifecycle

### Compaction

eve dispatches the existing `compaction.requested` event before each automatic or manual compaction pass. Each resolved slot receives the complete durable message history about to be compacted, before any message is summarized or removed. eve awaits the handlers in stable slot-path order before starting compaction, allowing a provider to extract, snapshot, or persist information that the checkpoint may omit. Handlers are side-effect-only and cannot alter eve's compaction input or algorithm.

After the compacted checkpoint has been written to durable history, eve dispatches `compaction.completed`. Each handler receives the settled post-compaction durable history. The event occurs only after successful compaction; a failed summarization preserves the prior history and does not emit it. Provider tools are not resolved at either boundary because compaction does not invoke the agent model.

Both snapshots exclude transient provider context. If compaction occurs later in a multi-step turn, eve keeps the prepared-turn context separate from the compaction input and reapplies it to the remaining model steps without writing it into the checkpoint.

### Turn preparation

After turn admission and any required initial compaction, eve dispatches `turn.prepared` to the `events` map of each slot whose scope resolved at turn start. This is a new provider-resolution event rather than the existing stream `turn.started`: its name reflects that the newest input has been admitted and the model history has already been compacted. The event context includes that input and every model-visible user, assistant, and tool message retained after compaction.

The event handler runs before the tool resolver for the same slot. A non-empty `context` result becomes one transient user-context message appended at the prompt tail. Results from several slots appear in stable slot-path order. Providers own all formatting and attribution within their returned text.

Recalled context is not a system instruction. Keeping it at the prompt tail leaves authored instructions and the prior conversation prefix stable for prompt caching. It also remains transient: eve does not write it to durable session history, include it in later capture input, or restore it on replay as conversation authored by the user.

eve resolves `tools["step.started"]` before each model call. Its most recent result owns that provider's tool set, and `null` clears it. A provider returns tool keys such as `forget` or `propose`; eve lowers them as `<memory-slot>__<provider-tool>`, for example `user__forget`. Qualification is unconditional, so adding another memory slot never renames an existing tool or creates a collision when two slots use the same provider.

The model never supplies slot identity or scope. eve binds the resolved invocation to each lowered executor, and provider code uses that bound scope for its service or storage call. Provider tools otherwise use the ordinary tool contract, including schemas, approvals, results, and authorization access. A provider may expose tools unrelated to conventional memory CRUD.

### Turn completion

After `turn.completed`, eve dispatches the event to `events["turn.completed"]` for every slot that resolved during turn preparation. The handler receives the same locked scope and the complete settled durable model history, including assistant tool calls and tool results. It does not receive transient context returned by `events["turn.prepared"]`.

eve awaits the completed-turn handlers before emitting `session.waiting` in conversation mode or `session.completed` in task mode. A caller that starts the next turn after the ready boundary therefore observes acknowledged provider state. The handler does not run for failed, cancelled, abandoned, deferred, or adapter-consumed turns, nor for manual clear or compaction boundaries that did not complete a turn.

The provider decides whether the handler stores the whole session, extracts selected details, rewrites a document, queues its own downstream work, or does nothing. eve does not run a capture model or inspect what the provider persists.

### Failures

A `turn.prepared` event-handler failure fails the turn. A `step.started` tool-resolution failure fails that step. Memory is an authored capability, so silently running with a different prompt or tool set would violate the agent definition.

A `compaction.requested` handler failure aborts the compaction before durable history changes. Automatic compaction fails the active turn or step; manual compaction emits a diagnostic and returns to `session.waiting` with the previous history. A `compaction.completed` handler failure occurs after the durable checkpoint and cannot roll it back; eve emits a diagnostic and continues the active turn or ready boundary.

A `turn.completed` handler failure likewise occurs after the response and cannot change that completed response. eve emits content-free diagnostics and continues to `session.waiting` or `session.completed`. Providers that acknowledge an event before their own asynchronous persistence completes own the resulting eventual consistency and retry behavior.

## Reference providers

V1 includes two reference providers to prove that the framework boundary does not encode one memory architecture. Package names, credentials, deployment configuration, and service-specific controls belong in provider-specific plans.

### Supermemory

On `turn.prepared`, the Supermemory provider sends the resolved scope and visible session history to Supermemory. Supermemory decides what is relevant, and the handler returns the fully formatted text that eve injects. eve does not understand Supermemory profiles, containers, documents, search, or extraction.

The provider's tool map may expose scoped search, save, forget, profile, or proposal tools, or another capability entirely. eve only qualifies and scope-binds the returned definitions.

On `turn.completed`, the provider sends the settled session to Supermemory. Supermemory decides what to persist and how to update its own memory representation. eve does not translate the session into framework records or validate the resulting writes.

### Blob documents

The blob provider stores bounded `USER.md`- and `MEMORY.md`-style text documents under the resolved scope. Its `turn.prepared` handler reads the documents and returns their provider-formatted contents directly; it requires no search, embeddings, or record schema.

The provider owns any tools for editing, consolidating, or clearing those documents. Its `turn.completed` handler may rewrite them from the settled session and enforce provider-configured size limits. File layout, truncation or consolidation policy, concurrency, and blob-store behavior remain internal to the provider.

This provider demonstrates that simple bounded text can participate in the same lifecycle as a hosted semantic service without eve standardizing either implementation.

## Observable guarantees

- Memory slots have path-derived identity and an explicit authored scope.
- Scope is resolved from trusted runtime context, locked for the turn, and never accepted from model input.
- The same provider can back several slots without sharing eve scope keys or colliding model tools.
- `events["compaction.requested"]` sees the complete pre-compaction durable history, while `events["compaction.completed"]` sees the successfully checkpointed durable history.
- `events["turn.prepared"]` sees the post-compaction visible session including the newest input and may contribute transient tail context in deterministic slot order.
- Transient prepared-turn context appears in neither compaction snapshot nor durable history.
- Provider tools are unconditionally slot-qualified and bound to the same locked scope as provider event handlers.
- `events["turn.completed"]` sees the completed durable session without prepared-turn transient context and settles before the next ready boundary.
- Prepared-turn event and tool-resolution failures fail the active turn or step; completed-turn event failures cannot rewrite the response or suppress the ready boundary.
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

Before V1 implementation lands, follow-up plans must fix the exact public type names, introduce the `turn.prepared` resolution point, connect provider handlers to the existing compaction events, define event/tool-map compilation and durable-replay mechanics, specify scope-part encoding, diagnostics and cancellation, and add tests for lifecycle ordering and isolation. Supermemory and blob storage each need a provider-specific plan for configuration and operational behavior without expanding the core memory contract.

## Primary references

- [Supermemory: how it works](https://supermemory.ai/docs/concepts/how-it-works)
- [Hermes Agent memory](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/memory.md)
- [eve dynamic capabilities](../docs/guides/dynamic-capabilities.md)
- [eve project layout](../docs/reference/project-layout.md)
- [eve prompt caching](../packages/eve/src/harness/prompt-cache.ts)
- [eve turn execution](../packages/eve/src/execution/workflow-steps.ts)
