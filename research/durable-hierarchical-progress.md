---
issue: https://github.com/vercel/eve/issues/1673
status: proposed
last_updated: "2026-08-05"
---

# Durable hierarchical progress

## Summary

eve should represent progress independently from any channel presentation. Agent
lifecycle facts reduce into a durable progress projection; delegated agents
publish their projection to their parent, which incorporates it into its own
projection. Only the root channel reconciles the resulting projection into an
external presentation.

```text
child lifecycle facts ──reduce──▶ child projection
                                      │ durable child update
                                      ▼
parent facts + child projections ──reduce──▶ parent projection
                                              │
                                              ▼
                                      channel reconciler
                                  indicator | message | blocks
```

A Slack thread status is one possible reconciler. A replaceable thread message,
a Block Kit tree of parallel work, a terminal spinner, or no visible rendering
are equally valid. Progress is desired state, not a command to call a specific
channel API.

## Current Slack behavior

Slack status text currently comes directly from channel event handlers in
`public/channels/slack/defaults.ts`:

| Source                                         | Current projection                                                                                                    |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| inbound mention or DM                          | `Thinking...` before runtime dispatch                                                                                 |
| `turn.started`                                 | `Working...`                                                                                                          |
| `reasoning.appended`                           | first non-empty reasoning line, locally throttled                                                                     |
| `actions.requested`                            | preceding assistant narration when available, otherwise a label derived from the first requested action and `+N more` |
| `message.completed`                            | preserve narration before tool calls; otherwise post the answer or clear an empty status                              |
| `authorization.completed`                      | `Connected to <name>. Resuming...`                                                                                    |
| terminal session/turn events and visible posts | stop or supersede the active status                                                                                   |

This is an implicit last-write-wins reducer spread across event handlers and
`SlackChannelState` fields:

- `pendingToolCallMessage` carries narration across `message.completed` and
  `actions.requested`;
- `lastReasoningTyping*` implements presentation throttling;
- `statusKeepaliveStatus` remembers the latest non-empty desired status;
- the thread-status controller turns that desired string into
  `assistant.threads.setStatus` calls and refreshes it while work is parked.

The status text is therefore derived from useful channel-neutral facts, but its
reduction, scheduling, and Slack effect are currently interleaved.

## Existing event and delegation boundaries

Normal root-agent stream events pass through the active channel adapter in
`execution/workflow-steps.ts`. This gives Slack the facts above, but does not
persist an explicit progress projection.

Delegated agents run with the framework-owned subagent adapter. Today it only
forwards child authorization and input-request events through the parent's
durable turn inbox. The parent separately observes:

- `actions.requested`, which identifies the requested subagent call;
- `subagent.called`, emitted after a durable child starts;
- the terminal runtime-action result returned through the inbox.

The child agent's ordinary turn, reasoning, action, and nested-subagent events
do not bubble to the parent. The protocol contains inline `subagent.started`,
`subagent.event`, and `subagent.completed` shapes, but delegated workflow
subagents do not use those as a general child event stream. A hierarchical
progress design therefore needs a new durable child-progress lane rather than
assuming the parent can reduce its child's existing public stream.

PR [#1665](https://github.com/vercel/eve/pull/1665) adds another useful source:
streaming tools may yield complete intermediate output snapshots, exposed as
`action.partial`. This is an incremental tool-output data plane rather than a
progress model. The snapshots are arbitrary tool output, can be much richer
and more frequent than useful status changes, and are independently valuable
to clients. Progress reduction may consume them without making every partial a
progress revision or forwarding raw partials through the subagent tree.

## Existing agent workarounds

Internal agents already implement two ends of the desired design outside eve.
They are useful requirements, not APIs to preserve.

`v` maintains a small delegation reducer in its Slack channel state:

- `actions.requested` extracts remote and local calls by `callId`, records
  `pendingDelegations`, and reduces names to `calling d0 + content...`;
- `action.result` removes the matching call and records failures and elapsed
  time;
- a detached 75-second loop re-renders that same status, adds elapsed minutes,
  posts a five-minute still-working notice, and eventually probes remote child
  sessions before deciding whether work is alive, stalled, or unknown;
- `subagent.called` is attached by reaching into the channel adapter because
  the public Slack event map cannot expose the child session id. The id is
  copied to Postgres because the detached refresh invocation cannot read the
  parent's durable channel state.

This is an operation-set reducer plus a channel reconciler, but lifecycle,
liveness, rendering, timer ownership, and external persistence are interleaved.
It demonstrates that a useful aggregate needs stable call identity, child
session identity, parallel labels, elapsed time, stale/unknown semantics, and
an explicit distinction between refreshing presentation and changing progress.

`e0` demonstrates structured, model-authored progress. Its `todo` results are
validated as full snapshots, keyed by root or child session and turn, and
reconciled into one Slack message that is updated in place. Root plans remain
visible as completed; child plans are removed at child completion. e0 also
attaches to each local child session stream to observe nested todo results,
reasoning summaries, and action requests, then writes all of them directly to
the parent Slack thread. This is effectively a hand-built hierarchical progress
projection, but it depends on channel-side child stream attachment and embeds
Slack message metadata in the persistence strategy.

Together these implementations favor a layered authoring model:

1. tools publish structured snapshots or tool-owned progress contributions;
2. eve owns the default action/child tree and lifecycle invariants;
3. the agent level materializes a deterministic canonical progress graph;
4. the root channel selects and summarizes that graph, then reconciles the
   presentation, including timer-driven refresh.

Other internal agents reinforce this boundary. Revoa executes approved plans
with deterministic per-step callbacks carrying step index, total, description,
and result, then maps those facts to one updated Slack message. CSE maintains a
durable investigation budget from `actions.requested`: deadline, maximum
subagent calls, and calls used. Devbox maps known tools to authored activity
labels and deliberately suppresses noisy polling while retaining task state.
None of the inspected channel implementations invokes an LLM to derive status
from lifecycle events. They use typed state, stable identities, and explicit
policy, then apply opinion only while rendering.

## External prior art

No inspected framework provides the complete combination of durable canonical
progress, hierarchical child rollup, and channel-specific summarization. The
closest systems support distinct pieces and generally preserve structured facts
before rendering them.

### AG-UI activities

[AG-UI](https://github.com/ag-ui-protocol/ag-ui) is the closest presentation
protocol. `ACTIVITY_SNAPSHOT` carries a stable `messageId`, open
`activityType`, and arbitrary structured `content`; `ACTIVITY_DELTA` applies
RFC 6902 patches to that content. Its Mastra background-agent example maps a
long-running tool to an activity whose content includes task id, tool name,
status, arguments, outputs, and result, while a custom renderer displays a
Background Task card. Normal tool rendering can be suppressed without losing
the structured activity.

This supports snapshot identity, replace-in-place semantics, open activity
types, and renderer-owned presentation. It does not define how nested agents
reduce their activity into a parent, durability/replay semantics, or a canonical
cross-agent schema. eve can potentially project its root canonical graph into
AG-UI activity snapshots without adopting AG-UI as internal durable state.

### A2A tasks

The [Agent2Agent protocol](https://github.com/a2aproject/A2A) separates a
retrievable `Task` snapshot from streamed updates. A task has lifecycle state,
status message, artifacts, history, and metadata. `TaskStatusUpdateEvent`
replaces status using stable task and context ids; `TaskArtifactUpdateEvent`
updates an artifact independently and supports append/final-chunk semantics.
Disconnected clients receive significant notifications and then fetch the
complete current task.

A2A validates the snapshot-plus-notification model and the separation between
status and incremental output. Its lifecycle is intentionally coarse
(`working`, `input-required`, `auth-required`, terminal states), its status
message is agent-authored prose, and it does not standardize nested child trees
or presentation reduction.

### LangGraph state and stream projections

[LangGraph](https://github.com/langchain-ai/langgraph) combines deterministic
state-channel reducers with separate stream modes. Nodes can emit arbitrary
`custom` stream data through a runtime writer. Stream events carry namespaces,
and subgraph streaming preserves nested namespaces. Its newer stream
transformers observe the event mux and build typed derived projections without
changing graph state; async derived work can land on an independent projection.

This is strong precedent for keeping durable execution state separate from
consumer projections and for preserving hierarchy through namespaces. The
custom writer remains an untyped data plane, however, and LangGraph does not
supply an opinionated agent-progress graph or channel refresh contract.

### Agent SDK lifecycle streams

OpenAI Agents SDK and AutoGen expose normalized higher-level events for tool
calls/results, handoffs or agent changes, messages, and reasoning. AutoGen
explicitly describes agent events as observable by users and applications, not
agent-to-agent communication. These are useful fact sources but leave state
materialization and presentation to consumers. They resemble eve's existing
stream more than the proposed canonical progress layer.

Google ADK preserves hierarchy more explicitly: events carry workflow node
paths, parent run identity, branch/isolation scope, output ownership, and state
deltas. This is relevant to canonical child identity and visibility, but it is
still a session event model rather than a reduced progress projection.

### Operation-local progress

MCP progress notifications correlate `progress`, optional `total`, and optional
message to one request token. Temporal activity heartbeats persist arbitrary
latest details, support retry resumption, and double as liveness/cancellation
checkpoints. Both reinforce operation-local typed progress with stable identity.
Neither performs agent-level rollup. Temporal heartbeats are control-plane
state, not a user-facing event stream, which is a useful warning not to equate
liveness with presentation.

### Design consequence

The recurring external shape is:

```text
operation events or snapshots
        │ stable id + structured state
        ▼
durable task/graph state
        │ notification or projection stream
        ▼
consumer-owned renderer
```

AG-UI is the strongest precedent for the outer activity/rendering boundary;
A2A for durable task snapshots and reconnect; LangGraph and Google ADK for
hierarchical identity and derived projections; MCP and Temporal for
operation-local progress. None is evidence for lossy or model-based reduction
inside every child. An optional channel summarizer remains a novel but natural
consumer-owned stage, and should cache by canonical projection fingerprint.

## Public API design space

The public API needs boundaries at four levels: producers contribute meaning,
the agent materializes canonical state, delegated sessions publish canonical
snapshots, and the root channel projects and reconciles a presentation. These
levels should not share one generic `reduce(event)` callback.

### Canonical types

Three shapes are plausible.

#### Recursive activity tree

```ts
interface ProgressSnapshot {
  readonly revision: number;
  readonly root: ProgressScope;
}

interface ProgressScope {
  readonly id: string;
  readonly kind: "agent";
  readonly name: string;
  readonly phase: ProgressPhase;
  readonly summary?: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly activities: readonly ProgressActivity[];
}

type ProgressActivity = ProgressAction | ProgressChild | ProgressPlan | ProgressBlocker;

interface ProgressChild extends ProgressActivityBase {
  readonly kind: "agent";
  readonly callId: string;
  readonly sessionId: string;
  readonly progress: ProgressScope;
}
```

This is easiest for renderers and naturally represents nested agents. Updating a
deep child replaces a path and can duplicate large subtrees on the wire unless
snapshots are bounded or structurally shared internally.

#### Normalized graph

```ts
interface ProgressSnapshot {
  readonly revision: number;
  readonly rootId: string;
  readonly nodes: Readonly<Record<string, ProgressNode>>;
}

interface ProgressNode {
  readonly id: string;
  readonly parentId?: string;
  readonly kind: "agent" | "action" | "plan" | "blocker";
  readonly phase: ProgressPhase;
  readonly children: readonly string[];
  readonly contribution?: ProgressContribution;
}
```

This is compact, stable under replacement, and convenient for stale-revision
checks. It is less pleasant for ordinary channel authors and exposes graph
integrity concerns they should not need to maintain.

#### Snapshot plus opaque extension contributions

```ts
interface ProgressActivity {
  readonly id: string;
  readonly kind: string;
  readonly phase: ProgressPhase;
  readonly label?: string;
  readonly data?: JsonValue;
}
```

This is extensible but gives channels little portable structure. Every renderer
would eventually switch on tool-specific `kind` values.

The recommended public read shape is a recursive tree with a bounded canonical
schema. The runtime may store or propagate it as a normalized graph. Domain data
can ride in namespaced optional annotations, but core identity, phase, nesting,
counts, timestamps, and errors remain portable.

```ts
type ProgressPhase = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

interface ProgressContribution {
  readonly label?: string;
  readonly detail?: string;
  readonly completed?: number;
  readonly total?: number;
  readonly unit?: string;
}
```

`label` and `detail` are semantic authored copy, not channel markup. They are
optional because an action's tool or agent name is already a deterministic
fallback.

### Producer APIs

There are three useful producer shapes, and eve likely needs two of them.

#### Explicit operation-local reporting

```ts
export default defineTool({
  async execute(input, ctx) {
    await ctx.progress.report({
      label: "Indexing documents",
      completed: 250,
      total: 1_000,
      unit: "documents",
    });
  },
});
```

This is natural for callbacks, MCP progress, and long operations that know when
a meaningful milestone occurs. `report` must be asynchronous and revisioned.
Its durability semantics must be explicit: it sends an out-of-band checkpoint
rather than pretending an atomic tool step committed early. Rapid reports may
coalesce latest-per-call while preserving the latest accepted checkpoint.

#### Projection from tool lifecycle and partial output

```ts
export default defineTool({
  async *execute(input) {
    yield { indexed: 250, total: 1_000 };
    yield { indexed: 1_000, total: 1_000 };
  },
  progress: {
    started(input) {
      return { label: `Indexing ${input.collection}` };
    },
    updated(output) {
      return {
        completed: output.indexed,
        total: output.total,
        unit: "documents",
      };
    },
    completed(output) {
      return { label: `Indexed ${output.total} documents` };
    },
  },
});
```

This keeps a typed relation to tool input/output and lets `action.partial`
remain a richer client stream. It cannot describe milestones that are not
represented in yielded output.

#### Generic progress tool

A model-facing `report_progress` tool is useful for semantic work between tools,
but should be additive. Requiring the model to narrate every operation is noisy
and unreliable. Structured `todo` remains the better source for multi-step
plans.

Recommended producer API: support explicit `ctx.progress.report()` and an
optional typed `progress` projector on `defineTool`. Both normalize to the same
`ProgressContribution`; the last accepted explicit report wins over an inferred
partial contribution until another lifecycle boundary.

### Agent-level authoring

A raw `(state, event) => state` replacement API is too easy to make lossy or
break child and terminal invariants. Consider three levels of power.

#### Declarative policy

```ts
export default defineAgent({
  model: "openai/gpt-5.4",
  progress: {
    retainCompletedActions: 5,
    retainCompletedChildren: "turn",
    plans: "prefer-over-actions",
  },
});
```

This handles common retention choices but cannot add domain-specific aggregate
state.

#### Canonical annotations

```ts
export default defineAgent({
  model: "openai/gpt-5.4",
  progress: defineProgress({
    annotate(snapshot, update) {
      if (update.kind === "plan.updated") {
        return { focus: update.plan.items.find((item) => item.phase === "running")?.label };
      }
    },
  }),
});
```

Annotations add bounded, serializable information while the framework still
owns the canonical graph. They do not remove or rewrite nodes.

#### Reducer middleware

```ts
progress: defineProgress({
  reduce(base, update) {
    const next = base(update);
    return { ...next, annotations: updateAnnotations(next, update) };
  },
});
```

This is flexible but exposes ordering and replay semantics. If offered, `base`
must always establish structural invariants first, and the callback should only
be able to change an owned extension state or derived annotations, not core
nodes.

Recommended initial API: an optional `progress` field on `defineAgent` with
declarative retention plus typed `annotate`. Every subagent definition gets the
same surface. Do not add a separate filesystem slot until multiple independent
progress modules need composition.

The canonical projection should also be observable without being mutable:

```ts
export default defineHook({
  events: {
    "progress.updated"(event, ctx) {
      console.info(event.data.progress.revision);
    },
  },
});
```

This event fires only when canonical state changes, not on channel refresh.

### Delegated-agent boundary

The child-to-parent contract should remain framework-owned. Public authors read
the same `ProgressSnapshot` whether a scope is root or nested; they do not send
`subagent-progress` hook payloads themselves. A child may attach an authored
semantic annotation or summary, but cannot choose what the parent discards.

For remote agents, capability negotiation can accept either:

```ts
{
  kind: ("progress.snapshot", revision, progress);
}
```

or a coarse A2A-style task status that eve adapts into one child node. Lack of
progress capability leaves the child as a running node until its terminal
result.

### Channel APIs

The channel boundary needs to distinguish pure/derived presentation from
external effects and refresh. Three shapes are plausible.

#### One effectful callback

```ts
progress: async ({ progress, reason }, channel, ctx) => {
  await channel.thread.startTyping(selectStatus(progress));
  return { refreshAfterMs: 75_000 };
};
```

This is simple and fits existing channel event handlers. It makes model-summary
caching, create-versus-update state, and testability the author's problem.

#### Project then reconcile

```ts
progress: defineChannelProgress({
  async project(progress, ctx) {
    return summarizeForSlack(progress, ctx);
  },
  async reconcile(view, channel, ctx) {
    await channel.thread.startTyping(view.status);
    return { refreshAfterMs: 75_000 };
  },
});
```

`project` runs only for a changed canonical fingerprint. It may call a cheap
model and must return serializable presentation state. `reconcile` runs for
`changed`, `refresh`, and `terminal` reasons and owns effects. On refresh it
receives the cached view.

#### Event reducer over canonical changes

```ts
progress: {
  initial: () => ({ messageTs: null, view: null }),
  reduce(state, event) { /* changed | refresh | terminal */ },
}
```

This resembles UI reducers but mixes pure state and effects unless another
command layer is introduced.

Recommended channel API: project then reconcile.

```ts
interface ChannelProgressProjectContext {
  readonly reason: "changed" | "terminal";
  readonly previous?: ChannelProgressPresentation;
  readonly session: SessionContext["session"];
}

interface ChannelProgressReconcileContext<TPresentation> {
  readonly presentation: TPresentation;
  readonly previous?: TPresentation;
  readonly reason: "changed" | "refresh" | "terminal";
}

interface ChannelProgressReconcileResult {
  readonly refreshAfterMs?: number;
}
```

For a custom channel:

```ts
export default defineChannel({
  state: { progressMessageId: null },
  progress: defineChannelProgress({
    project(progress) {
      return mechanicalSummary(progress);
    },
    async reconcile(input, channel) {
      channel.state.progressMessageId = await upsertProgressMessage(
        channel.state.progressMessageId,
        input.presentation,
      );
      return {};
    },
  }),
});
```

For Slack, the built-in offers presets and an escape hatch:

```ts
slackChannel({
  progress: slackProgress.status(),
});

slackChannel({
  progress: slackProgress.message({
    blocks(progress) {
      return renderParallelAgentBlocks(progress);
    },
  }),
});

slackChannel({
  progress: defineSlackProgress({ project, reconcile }),
});
```

`slackProgress.status()` refreshes the cached status presentation before Slack
expires it. `slackProgress.message()` updates a thread message and normally
requests no refresh. `progress: false` suppresses the built-in renderer without
suppressing canonical progress or `progress.updated` observation.

### API recommendation

The smallest coherent first public surface is:

1. `ProgressContribution`, `ProgressSnapshot`, and recursive read-only node
   types;
2. `ctx.progress.report()` for operation-local milestones;
3. optional typed tool `progress` projectors;
4. agent `progress` retention/annotation policy, not arbitrary core reduction;
5. `progress.updated` as an observe-only hook event;
6. `defineChannelProgress({ project, reconcile })` with cached project output
   and refresh reasons;
7. Slack status and message presets built on the same channel contract.

The runtime child propagation protocol remains internal until remote capability
negotiation requires a public wire contract.

## Proposed semantic split

### Progress facts

A progress fact records a meaningful lifecycle transition, not presentation
instructions. Initial facts should cover:

- turn started, waiting, completed, failed, or cancelled;
- reasoning summary changed;
- actions requested and actions settled, keyed by call id;
- authorization or human input required and resumed;
- delegated child started, updated, and settled, keyed by call id and child
  session id;
- a streaming tool published a new intermediate output snapshot, keyed by call
  id.

Facts need stable identities and ordering coordinates. They must not contain
Slack text, blocks, message timestamps, refresh intervals, or API operations.
High-frequency stream deltas and tool partials may be ignored or coalesced
before reduction, but the latest desired projection must cross the next
durable boundary. A default reducer should not guess status text from arbitrary
partial output. An authored reducer can interpret a tool's domain-specific
snapshot; a future tool-level projector could explicitly map `TOutput` to a
small progress contribution without changing what clients or the model see.

### Canonical agent projection

The agent-level reducer folds facts into durable canonical state. It must be
deterministic, side-effect free, and deliberately low-loss so workflow retries
produce the same result and every parent receives enough structure to choose a
different presentation. It may compact transport detail, such as replacing ten
partials for one call with the latest typed contribution, but should retain
active action identities, child projections, plan items, phases, timestamps,
errors, and terminal outcomes.

A default reducer can preserve today's broad behavior while producing a
channel-neutral tree:

```ts
interface ProgressNode {
  readonly id: string;
  readonly phase: "active" | "blocked" | "completed" | "failed" | "cancelled";
  readonly summary?: string;
  readonly children?: readonly ProgressNode[];
}
```

This shape is illustrative rather than final. In particular, completed child
retention, ordering, error detail, and whether `summary` is authored text or a
structured activity need API design.

Custom reduction should be configured independently from channel rendering.
Two viable authoring shapes need a spike:

1. **Constrained projection:** users customize `(projection, fact) =>
ProgressNode`. Every channel can understand the result, but the shared shape
   may become either too weak or presentation-shaped.
2. **Generic projection:** users own serializable reducer state and output;
   their channel reconciler consumes the matching type. This is expressive but
   requires a clean way to connect agent and channel types across filesystem
   definitions and delegated-agent boundaries.

Do not require an agent author to reconstruct the action map, child revision
checks, or terminal precedence. Those are framework invariants. Agent-level
authoring should primarily add typed domain contributions and configure bounded
retention, not collapse the graph to one display string. Tool-level projectors
answer what one operation's output means; the canonical reducer combines those
contributions without deciding what a particular audience should see.

A child may publish an explicit semantic summary because it understands its own
domain, but that summary is one field alongside its canonical child projection,
not a replacement for it. Automatically invoking a summarization model at each
subagent boundary would add latency, cost, nondeterminism, and cumulative
information loss. If a very wide tree eventually requires hierarchical model
summaries, store them as optional derived annotations keyed by the source
projection fingerprint and always propagate the source projection too.

Start with the constrained internal projection to establish semantics. Do not
expose a public reducer until the tree survives nested delegation without
channel-specific fields.

### Channel reconciler

The root channel receives a complete desired projection and reduces it into a
presentation before reconciling external state. It owns effectful and
presentation-specific concerns:

- select which canonical nodes matter for this channel and audience;
- optionally summarize them with authored code or a cheap model;
- choose an indicator, one updated message, multiple posts, or blocks;
- create and remember external resource ids;
- update or clear prior presentation;
- truncate, throttle, debounce, and refresh according to platform limits;
- decide how completed children remain visible.

A model summarizer is an optional, best-effort presentation stage. Its input is
the bounded canonical graph; its output is cached by projection fingerprint in
channel state. Failure falls back to deterministic copy. A timer refresh with
an unchanged fingerprint reuses the cached summary and repeats only the channel
effect, so a 75-second Slack refresh neither calls the model again nor creates a
progress revision.

The reconciler's durable channel state contains external ids, the last
successfully rendered projection fingerprint, and any cached presentation.
Canonical reducer state must not contain those values. Reconciliation is
best-effort and must not fail the agent turn.

## Hierarchical propagation

Each session reduces its own facts. A delegated session sends a versioned
snapshot when its desired projection changes:

```ts
interface ChildProgressUpdate {
  readonly kind: "subagent-progress";
  readonly callId: string;
  readonly childSessionId: string;
  readonly revision: number;
  readonly projection: ProgressNode;
  readonly subagentName: string;
}
```

The parent admits this through the same durable turn inbox ownership model used
for child HITL and terminal results, but handles it as a separate payload. It
rejects stale revisions, associates the child with the pending call, reduces
the child snapshot into its own state, and publishes its new snapshot upward
if it is itself delegated.

Snapshots, rather than every raw child event, provide three properties:

1. a parent never needs to replay the child's complete event history;
2. nested trees compose one level at a time;
3. update volume can be coalesced without losing current desired state.

The snapshot must retain stable child and action identities so a custom reducer
can display parallel work rather than collapsing everything to the latest
string. Parent reduction remains authoritative: it can summarize, hide, reorder,
or retain child nodes instead of blindly embedding them.

Terminal delivery and progress delivery can race. Revisions and the terminal
fact must make both orders converge to the same parent projection. A late child
snapshot cannot resurrect a settled call.

## Durability and ownership

Reducer state belongs to the session's durable runtime state, not process-local
maps or channel adapter state. Reduction occurs in the same durable step that
observes the source lifecycle event. A changed delegated projection is then
forwarded through a workflow hook step to its parent.

The root channel reconciler observes projections after they have been adopted
into serialized context. Its effect checkpoint includes updated channel state.
External APIs without idempotency still have an unavoidable response/checkpoint
crash window; initial implementations should prefer naturally idempotent
replace operations and explicitly document create-operation semantics rather
than claiming exactly-once posts.

Progress propagation must never block model execution or terminal settlement
indefinitely. Failed parent notification or channel rendering is diagnostic;
the latest durable projection can be retried or superseded by a newer revision.

## Relationship to status keepalive

The status-keepalive work supplies useful scheduling for a root channel whose
current presentation expires while the parent waits on delegated results. It
is not the progress model.

Under this design:

- reducer output establishes desired progress;
- the channel reconciler renders that desired progress;
- optional status refresh reasserts an expiring presentation without producing
  a new progress fact or reducer revision.

A Block Kit reconciler may return no refresh deadline at all. A status
indicator reconciler may request periodic refreshes. The durable progress tree
and child propagation are unchanged in either case.

## Open decisions

1. Is a progress projection part of the public event stream, or only an
   internal channel/subagent projection? Publishing it helps non-channel
   clients but creates a long-lived protocol contract.
2. Which reasoning representation is safe and useful as progress? Raw reasoning
   may be unsupported by some providers and inappropriate to expose verbatim.
3. Should custom reducers be agent-level, channel-level, or composed from an
   agent reducer and a channel projection policy?
4. How are reducer versions pinned and migrated for sessions spanning
   deployments?
5. What coalescing boundary prevents reasoning deltas from producing excessive
   workflow steps while preserving prompt updates?
6. Should a parent receive only the child's default projection, or can a child
   publish structured domain-specific progress explicitly?
7. Should tools declare a `toProgress`-style projector for `action.partial`
   snapshots, rely on the agent reducer to recognize their output, or gain a
   separate explicit progress-reporting API?
8. At what boundary are rapid tool partials coalesced so clients retain the
   full incremental stream while parent progress receives only meaningful
   snapshots?
9. How long do completed child nodes remain in the projection, especially when
   persistent subagent sessions are continued by a later call?
10. Is elapsed time a renderer concern, a refresh-time projection over durable
    `startedAt`, or semantic progress? v needs it without creating a new child
    revision every minute.
11. How should liveness observations such as v's remote session probes enter
    progress without confusing "no recent event" with failure?
12. Can root and child structured plans use one projection while retaining e0's
    policy that completed root plans remain visible and child plans disappear?
13. What size bound on the canonical graph permits low-loss propagation without
    unbounded session growth? Retention should be explicit and deterministic,
    not delegated to a summarization model.
14. Does the channel summarizer receive auth/audience metadata so it can avoid
    exposing child details inappropriate for a shared thread, or must the
    canonical projection be visibility-labeled before it reaches the channel?

## Implementation sequence

1. Add pure internal progress facts, a default reducer, durable reducer state,
   and tests for one root session. Do not change channel output.
2. Add a versioned child-progress hook payload and prove nested, parallel,
   stale-update, terminal-race, retry, and cancellation semantics.
3. Feed root projections to an internal channel reconciler and adapt Slack's
   existing status behavior as the first renderer without changing visible
   defaults.
4. Spike an alternate Slack reconciler that maintains a thread message with
   parallel child blocks. Use the spike to validate the projection shape.
5. Only then expose reducer/reconciler authoring APIs, documentation, and a
   changeset.

## Verification

- root lifecycle facts reduce deterministically across replay;
- two parallel child calls retain independent identities and ordering;
- nested child updates bubble one parent at a time to the root;
- stale or late child revisions cannot overwrite terminal state;
- reducer and propagation failures do not fail an active turn;
- a renderer retry does not alter reducer state or emit a new child revision;
- indicator and message/block renderers consume the same projection;
- existing Slack-visible behavior remains unchanged until a renderer is
  explicitly selected.
