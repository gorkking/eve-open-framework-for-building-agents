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
projection. Only the root channel renders the resulting projection into an
external presentation.

```text
child lifecycle facts ──reduce──▶ child projection
                                      │ durable child update
                                      ▼
parent facts + child projections ──reduce──▶ parent projection
                                              │
                                              ▼
                                       channel renderer
                                  indicator | message | blocks
```

A Slack thread status is one possible rendering. A replaceable thread message,
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
`SlackChannelState` fields. `pendingToolCallMessage` carries narration across
`message.completed` and `actions.requested`; `lastReasoningTyping*` implements
presentation throttling. The status text is therefore derived from useful
channel-neutral facts, but its reduction and Slack effect are interleaved.

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

## Design boundary

The proposal separates four responsibilities:

1. operations publish structured reports or partial-output projections;
2. eve materializes deterministic canonical progress from existing turn, step,
   action, blocker, plan, and child-session state;
3. delegated sessions publish versioned canonical snapshots to their parent;
4. the root channel selects, summarizes, and renders a presentation.

Canonical progress is desired state, not an audit log and not presentation
commands. The durable event stream remains the complete history. Channel state
owns external message ids, capability fallbacks, and cached summaries.
Platform-specific presentation maintenance, such as renewing an expiring Slack
status, stays inside that channel implementation and is not part of the
canonical progress or generic channel contract.

## Public API design space

The public API needs boundaries at four levels: producers contribute meaning,
the agent materializes canonical state, delegated sessions publish canonical
snapshots, and the root channel renders a presentation. These
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
  readonly turn?: ProgressTurn;
}

interface ProgressTurn {
  readonly id: string;
  readonly phase: ProgressPhase;
  readonly plan?: ProgressPlan;
  readonly steps: readonly ProgressStep[];
  readonly blockers: readonly ProgressBlocker[];
}

interface ProgressStep {
  readonly stepIndex: number;
  readonly phase: ProgressPhase;
  readonly label?: string;
  readonly actions: readonly (ProgressAction | ProgressChild)[];
}

type ProgressActivity = ProgressAction | ProgressChild | ProgressPlan | ProgressBlocker;

interface ProgressChild extends ProgressActivityBase {
  readonly kind: "agent";
  readonly callId: string;
  readonly sessionId: string;
  readonly progress: ProgressScope;
}
```

This is easiest for renderers and naturally represents nested agents. A session
has at most one live turn projection; completed turn history stays in the event
stream rather than accumulating in `ProgressScope`. Updating a deep child
replaces a path and can duplicate large subtrees on the wire unless snapshots
are bounded or structurally shared internally.

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
  readonly report?: ProgressReport;
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

interface ProgressReport {
  readonly message?: string;
  readonly progress?: number;
  readonly total?: number;
  readonly unit?: string;
}
```

`message` is semantic authored copy, not channel markup. `progress` is the
amount completed, not necessarily a percentage; `total` uses the same scale.
Numeric fields align with MCP progress notifications, while eve adds optional
`unit` and permits message-only reports. Correlation is not public payload:
authored tools inherit their active `callId`, and the MCP adapter privately maps
`progressToken` to that call.

Plans deserve a core canonical variant rather than a namespaced annotation:

```ts
interface ProgressPlan extends ProgressActivityBase {
  readonly kind: "plan";
  readonly title?: string;
  readonly items: readonly ProgressPlanItem[];
}

interface ProgressPlanItem {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly phase: "pending" | "running" | "completed" | "cancelled" | "failed";
}
```

This supports plan cards, web checklists, and pinned TUI plans. The current
framework todo schema has no plan title, description, or item id. A first-class
plan contribution therefore requires a deliberate todo API change if stable
item identity is part of the contract.

### Producer APIs

There are three useful producer shapes, and eve likely needs two of them.

#### Explicit operation-local reporting

```ts
export default defineTool({
  async execute(input, ctx) {
    await ctx.reportProgress({
      message: "Indexing documents",
      progress: 250,
      total: 1_000,
      unit: "documents",
    });
  },
});
```

This is initially a `ToolContext` API: the active `callId` supplies ownership.
It is natural for long operations that know when a meaningful milestone occurs.
`reportProgress` must be asynchronous and revisioned. Its durability semantics must be explicit: it sends an out-of-band
checkpoint rather than pretending an atomic tool step committed early. Rapid
reports may coalesce latest-per-call while preserving the latest accepted
checkpoint.

MCP tools get this path without authored configuration when their server emits
`notifications/progress`. The MCP client supplies a private `progressToken`,
correlates the notification back to the active eve `callId`, and submits the
same internal report. MCP supplies no hierarchy; ordinary eve child snapshots
carry the resulting action progress upward.

#### Projection from tool lifecycle and partial output

```ts
export default defineTool({
  async *execute(input) {
    yield { indexed: 250, total: 1_000 };
    yield { indexed: 1_000, total: 1_000 };
  },
  progress: {
    started(input) {
      return { message: `Indexing ${input.collection}` };
    },
    updated(output) {
      return {
        progress: output.indexed,
        total: output.total,
        unit: "documents",
      };
    },
    completed(output) {
      return { message: `Indexed ${output.total} documents` };
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

Recommended producer API: support explicit `ctx.reportProgress()` and an
optional typed `progress` projector on `defineTool`. Both normalize to the same
`ProgressReport`; the last accepted explicit report wins over an inferred
partial contribution until another lifecycle boundary. The projector is a
convenience for `action.partial`; explicit reporting remains the primary API.

### Agent-level authoring

The initial agent API should be zero-config:

```ts
export default defineAgent({
  model: "openai/gpt-5.4",
});
```

A raw `(state, event) => state` replacement API is too easy to make lossy or
break child and terminal invariants. Fixed retention counts are also the wrong
abstraction: canonical progress is scoped around meaningful work, not a sliding
window of recent events.

Plans are optional. Today a turn has model-step and action-batch boundaries;
it has a plan only when the model calls the framework `todo` tool. Without a
plan, eve builds a faithful ladder from those existing boundaries:

```text
turn
├── step 0 [completed]
│   ├── search logs [completed]
│   └── read source [completed]
└── step 1 [running]
    ├── researcher [running]
    │   └── child progress…
    └── run reproduction [running]
```

Actions observed under the same `stepIndex` are siblings; the runtime's action
state determines which are concurrently active, since `actions.requested` may
arrive incrementally. A subagent action owns its child scope. Optional pre-tool
narration may label the step; otherwise channels derive mechanical copy from
action names. When `todo` exists, the canonical turn also carries its structured
plan:

```text
turn
├── plan
│   ├── Reproduce [completed]
│   ├── Implement fix [running]
│   └── Open PR [pending]
└── steps
    └── current step
        ├── edit file [completed]
        └── run tests [running]
```

The framework applies deterministic scope-based compaction:

- retain every active or blocked action;
- group planless actions by native step and action-batch boundaries rather than
  inferring a plan;
- keep the optional plan and native step ladder as orthogonal views: the current
  protocol does not identify which action implements which todo item;
- while a step is active, retain its completed actions;
- when a step completes, retain its outcome and collapse internal action detail
  from the live projection;
- retain failed/cancelled detail sufficient to explain the outcome;
- retain the current plan and active child scopes until their owning turn
  settles;
- leave the complete audit trail in the durable event stream.

Whether completed scopes are expanded or hidden is channel presentation policy.
`preferPlans` therefore does not belong on the agent definition either.
Agent-authored semantic state enters through optional structured plans and
`reportProgress()`, not a custom canonical reducer. Defer agent annotations and
reducer middleware until adoption demonstrates information that cannot be
expressed as a contribution.

The canonical projection should be observable without being mutable:

```ts
export default defineHook({
  events: {
    "progress.updated"(event, ctx) {
      console.info(event.data.progress.revision);
    },
  },
});
```

This event fires only when canonical state changes, not for presentation-only
channel maintenance.

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

or a coarse remote task status that eve adapts into one child node. Lack of
progress capability leaves the child as a running node until its terminal
result.

### Channel API

The initial channel surface is one effectful callback. It receives an extensible
input object and owns presentation state in the channel's existing durable
state:

```ts
interface ChannelProgressInput {
  readonly progress: ProgressSnapshot;
  readonly reason: "changed" | "terminal";
}
```

```ts
export default defineChannel({
  state: { progressMessageId: null },
  async progress({ progress, reason }, channel, ctx) {
    channel.state.progressMessageId = await upsertProgressMessage({
      messageId: channel.state.progressMessageId,
      progress,
      reason,
    });
  },
});
```

This fits existing channel event handlers and lets a channel post, update,
delete, summarize, or intentionally ignore progress. Model-summary caching,
create-versus-update state, and testability remain the author's responsibility.
Built-in channel presets may internally split pure projection from effects and
cache model-generated summaries by canonical fingerprint.

The callback runs only when canonical progress changes or terminates. A channel
that needs presentation-only maintenance owns its timer and reuses its last
rendered state without manufacturing a progress update.

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
  progress: slackProgress.plan({
    fallback: slackProgress.status(),
  }),
});

slackChannel({
  async progress({ progress, reason }, channel) {
    await renderCustomSlackProgress({ channel, progress, reason });
  },
});
```

`slackProgress.plan()` selects the optional canonical plan and falls back when
a turn has none. `slackProgress.message()` updates a thread message.
`slackProgress.status()` owns any Slack-specific status renewal internally.
`progress: false` suppresses the built-in renderer without suppressing canonical
progress or `progress.updated` observation.

### API recommendation

The smallest coherent first public surface is:

1. `ProgressReport`, `ProgressSnapshot`, and recursive read-only node types;
2. `ctx.reportProgress()` for operation-local milestones and automatic MCP
   progress adaptation;
3. optional typed tool `progress` projectors;
4. deterministic framework-owned scope reduction, with no initial agent config;
5. `progress.updated` as an observe-only hook event;
6. one effectful channel `progress({ progress, reason }, channel, ctx)` callback;
7. Slack status, plan, and message presets built on the same canonical input.

The runtime child propagation protocol remains internal until remote capability
negotiation requires a public wire contract.

## Proposed semantic split

### Progress facts

A progress fact records a meaningful lifecycle transition, not presentation
instructions. Initial facts should cover:

- turn and model-step started, completed, failed, or cancelled, preserving
  `stepIndex`;
- reasoning summary changed;
- action batches requested and actions settled, keyed by call id;
- authorization or human input required and resumed;
- delegated child started, updated, and settled, keyed by call id and child
  session id;
- a streaming tool published a new intermediate output snapshot, keyed by call
  id.

Facts need stable identities and ordering coordinates. They must not contain
Slack text, blocks, message timestamps, refresh intervals, or API operations.
High-frequency stream deltas and tool partials may be ignored or coalesced
before reduction, but the latest desired projection must cross the next durable
boundary. A default reducer should not guess status text from arbitrary partial
output. An authored tool projector can interpret its domain-specific snapshot
and map
`TOutput` to a small progress report without changing what clients or the model
see.

### Canonical agent projection

The framework canonical reducer folds facts into durable agent state. It must be
deterministic, side-effect free, and deliberately low-loss so workflow retries
produce the same result and every parent receives enough structure to choose a
different presentation. It may compact transport detail, such as replacing ten
partials for one call with the latest typed contribution, but should retain
active action identities, child projections, plan items, phases, timestamps,
errors, and terminal outcomes.

The public read shape is the recursive `ProgressSnapshot` above: agent scope,
the live turn, its native step ladder, optional plan, actions, blockers, and
nested child snapshots. The runtime may normalize this graph internally.

Canonical reduction is framework-owned and zero-config. Do not expose an
agent-level reducer initially: custom reduction could discard child progress,
break terminal precedence, or make different agents publish incompatible
snapshots. Opinionated selection and summarization belong in the channel
callback.

Do not require an agent author to reconstruct the action map, child revision
checks, terminal precedence, or retention. Those are framework invariants.
Agent-level authoring should add typed domain contributions, not collapse the
graph to one display string. Tool-level projectors answer what one operation's
output means; the canonical reducer combines and scope-compacts those
contributions around native turns and steps, and optional plans when present,
without deciding what a particular audience should see.

A child may publish an explicit semantic summary because it understands its own
domain, but that summary is one field alongside its canonical child projection,
not a replacement for it. Automatically invoking a summarization model at each
subagent boundary would add latency, cost, nondeterminism, and cumulative
information loss. If a very wide tree eventually requires hierarchical model
summaries, store them as optional derived annotations keyed by the source
projection fingerprint and always propagate the source projection too.

Do not expose a public agent reducer until the tree survives nested delegation
without channel-specific fields and a concrete adoption cannot be expressed as
a progress report or channel projection.

### Channel renderer

The root channel receives a complete desired projection and renders external
state. It owns effectful and presentation-specific concerns:

- select which canonical nodes matter for this channel and audience;
- optionally summarize them with authored code or a cheap model;
- choose an indicator, one updated message, multiple posts, or blocks;
- create and remember external resource ids;
- update or clear prior presentation;
- truncate, throttle, and debounce according to platform limits;
- decide how completed children remain visible.

A model summarizer is an optional, best-effort presentation stage. Its input is
the bounded canonical graph; its output may be cached by projection fingerprint
in channel state. Failure falls back to deterministic copy.

The renderer's durable channel state contains external ids, the last
successfully rendered projection fingerprint, and any cached presentation.
Canonical reducer state must not contain those values. Rendering is best-effort
and must not fail the agent turn.

## Hierarchical propagation

Each session reduces its own facts. A delegated session sends a versioned
snapshot when its desired projection changes:

```ts
interface ChildProgressUpdate {
  readonly kind: "subagent-progress";
  readonly callId: string;
  readonly childSessionId: string;
  readonly revision: number;
  readonly projection: ProgressSnapshot;
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

The snapshot must retain stable child and action identities so a channel can
display parallel work rather than collapsing everything to the latest string.
Parent canonical reduction embeds the child without lossy summarization; the
root channel decides what to summarize, hide, reorder, or expand.

Terminal delivery and progress delivery can race. Revisions and the terminal
fact must make both orders converge to the same parent projection. A late child
snapshot cannot resurrect a settled call.

## Durability and ownership

Reducer state belongs to the session's durable runtime state, not process-local
maps or channel adapter state. Reduction occurs in the same durable step that
observes the source lifecycle event. A changed delegated projection is then
forwarded through a workflow hook step to its parent.

The root channel renderer observes projections after they have been adopted
into serialized context. Its effect checkpoint includes updated channel state.
External APIs without idempotency still have an unavoidable response/checkpoint
crash window; initial implementations should prefer naturally idempotent
replace operations and explicitly document create-operation semantics rather
than claiming exactly-once posts.

Progress propagation must never block model execution or terminal settlement
indefinitely. Failed parent notification or channel rendering is diagnostic;
the latest durable projection can be retried or superseded by a newer revision.

## Open decisions

1. Is `progress.updated` part of the public client stream, only an authored
   hook event, or both? Publishing snapshots helps non-channel clients but
   creates a long-lived protocol contract.
2. Which reasoning representation is safe and useful as progress? Raw reasoning
   may be unsupported by some providers and inappropriate to expose verbatim.
3. Should a custom channel that uses model summarization receive a framework
   cache helper, or own caching in durable channel state?
4. How are reducer versions pinned and migrated for sessions spanning
   deployments?
5. What coalescing boundary prevents reasoning deltas from producing excessive
   workflow steps while preserving prompt updates?
6. Besides `reportProgress()` and structured plans, is another typed
   domain-specific contribution needed?
7. Should typed tool projectors for `action.partial` ship initially, or follow
   the explicit `reportProgress()` API?
8. At what boundary are rapid tool partials coalesced so clients retain the
   full incremental stream while parent progress receives only meaningful
   snapshots?
9. At which turn/step settlement boundary should completed child internals
   collapse, especially when persistent subagent sessions are continued by a
   later call?
10. Is elapsed time a renderer projection over durable `startedAt`, or semantic
    progress? It should not require a new child revision every minute.
11. How should remote liveness observations enter progress without confusing
    "no recent event" with failure?
12. Should the framework todo gain stable item ids, title, and description, or
    should richer plans remain a separate contribution? How should parent and
    child plans settle for channel renderers?
13. What size bound on the canonical graph permits low-loss propagation without
    unbounded session growth? Retention should be explicit and deterministic,
    not delegated to a summarization model.
14. Does the channel summarizer receive auth/audience metadata so it can avoid
    exposing child details inappropriate for a shared thread, or must the
    canonical projection be visibility-labeled before it reaches the channel?

## Implementation sequence

1. Add pure internal progress facts, native turn/step/action scopes, optional
   plan projection, durable reducer state, and tests for planless and planned
   root sessions. Do not change channel output.
2. Add `reportProgress()`, automatic MCP adaptation, and optional partial-output
   projection behind the same action-local report path.
3. Add a versioned child-progress hook payload and prove nested, parallel,
   stale-update, terminal-race, retry, and cancellation semantics.
4. Feed root projections to the channel progress callback and adapt Slack's
   existing status behavior as the first renderer without changing visible
   defaults.
5. Spike Slack plan and message presets, including a parallel-child block
   renderer. Use them to validate the projection shape.
6. Only then expose public APIs, documentation, and a changeset.

## Verification

- planless native step/action ladders and optional plans reduce deterministically
  across replay;
- two parallel child calls retain independent identities and ordering;
- nested child updates bubble one parent at a time to the root;
- stale or late child revisions cannot overwrite terminal state;
- reducer and propagation failures do not fail an active turn;
- a renderer retry does not alter reducer state or emit a new child revision;
- indicator and message/block renderers consume the same projection;
- existing Slack-visible behavior remains unchanged until a renderer is
  explicitly selected.
