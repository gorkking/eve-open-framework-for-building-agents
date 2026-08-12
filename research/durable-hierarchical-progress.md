---
issue: https://github.com/vercel/eve/issues/1673
status: proposed
last_updated: "2026-08-05"
---

# Durable hierarchical progress

## Summary

eve should maintain a durable, framework-owned work graph for the active turn
and its delegated work. The graph is derived from authoritative runtime
lifecycle state, composes through child sessions, and remains independent of
channel effects. A root channel may render a safe, selected view of that graph.

```text
runtime lifecycle + direct child state
                │
                ▼
       durable work graph
                │
                ▼
    channel-specific presentation
```

The first implementation should prove this boundary using existing lifecycle
facts and local subagents. It should not initially define a general progress
platform around plans, arbitrary annotations, public client events, remote
capability negotiation, or custom channel APIs.

A later PR should add action-local `reportProgress()` and automatic MCP progress
adaptation after action ownership, child propagation, and rendering semantics
are stable.

## Problem

Channels currently infer progress independently from low-level stream events.
Slack, for example, derives status text from turn start, reasoning, assistant
narration, action requests, authorization completion, visible output, and
terminal events. The resulting state is implicit and channel-local.

Delegated sessions make this boundary more visible. A parent knows that it
started a child and eventually receives its terminal result, but the child's
ordinary step and action lifecycle does not bubble through the parent. A channel
that wants to show parallel delegated work must attach to child streams and
rebuild ownership, ordering, and terminal state itself.

The missing primitive is not presentation text. It is durable work ownership:

> What work is currently active, waiting, or terminal, and what direct child
> work does it own?

## Design principles

1. **Observed work is the core.** The graph records runtime truth: active turn,
   model steps, actions, blockers, and delegated children.
2. **Plans are separate intent.** A todo list may later attach to a turn, but it
   does not define execution truth and does not imply action-to-plan-item edges.
3. **The graph is desired state, not history.** The durable event stream remains
   the complete audit trail.
4. **Reduction is framework-owned.** Agents do not customize graph invariants,
   retention, child revisions, or terminal precedence.
5. **Children publish snapshots.** Parents receive versioned child state rather
   than every raw child event.
6. **Presentation belongs to channels.** The graph contains no Slack blocks,
   message ids, API operations, or presentation-maintenance timers.
7. **Blockers are first-class.** Waiting for input, authorization, or approval is
   authoritative work state, not an absence of progress.
8. **Terminal state wins.** Late or replayed updates cannot resurrect settled
   actions or children.

## Proposed v1 semantics

### Work graph

The first graph is deliberately small and internal:

```ts
type WorkPhase = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

interface WorkSnapshot {
  readonly revision: number;
  readonly root: WorkScope;
}

interface WorkScope {
  readonly sessionId: string;
  readonly agentName: string;
  readonly phase: WorkPhase;
  readonly turn?: WorkTurn;
}

interface WorkTurn {
  readonly turnId: string;
  readonly phase: WorkPhase;
  readonly steps: readonly WorkStep[];
  readonly blockers: readonly WorkBlocker[];
}

interface WorkStep {
  readonly stepIndex: number;
  readonly phase: WorkPhase;
  readonly actions: readonly WorkAction[];
}

interface WorkAction {
  readonly callId: string;
  readonly kind: "tool" | "skill" | "subagent" | "remote-agent";
  readonly name: string;
  readonly phase: WorkPhase;
  readonly child?: WorkScope;
}

interface WorkBlocker {
  readonly id: string;
  readonly kind: "input" | "authorization" | "approval";
  readonly phase: "blocked" | "completed" | "cancelled";
  readonly ownerCallId?: string;
}
```

The public names and exact serialization are not committed by v1. The initial
shape should remain internal until two renderers consume it successfully.

### Planless turns

Every turn already has model-step and action boundaries. A planless graph uses
those boundaries directly:

```text
turn [running]
├── step 0 [completed]
│   ├── search docs [completed]
│   └── read source [completed]
└── step 1 [running]
    ├── run reproduction [running]
    └── researcher [running]
        └── child turn
            └── inspect traces [running]
```

Actions observed under the same `stepIndex` are siblings. Because
`actions.requested` may arrive incrementally, the reducer uses runtime action
state—not one event batch—to determine which actions are concurrently active.
A delegated action owns its child scope.

The graph does not infer a plan, user intent, or a relationship between an
action and a hypothetical task.

### Blocked work

A blocker belongs to the turn and may identify its owning action:

```text
turn [blocked]
├── step 1 [completed]
│   └── update feature flag [blocked]
└── approval [blocked]
    └── owner: update feature flag
```

When the blocker resolves, the same blocker settles and the turn resumes. It is
not replaced with a new unrelated status.

### Scope compaction

The live graph is not an audit log:

- retain all active and blocked actions;
- retain completed actions while their step remains active;
- collapse completed step internals to a step outcome when the turn advances;
- retain failure/cancellation detail needed to explain the outcome;
- retain active child scopes until their owning action settles;
- remove the completed turn from the live session scope after settlement;
- preserve the full sequence in the existing durable event stream.

These rules are deterministic framework invariants, not authored retention
settings.

## Local child propagation

A delegated local session reduces its own graph and publishes a versioned
snapshot through the existing parent turn inbox topology:

```ts
interface ChildWorkUpdate {
  readonly kind: "subagent-work";
  readonly callId: string;
  readonly childSessionId: string;
  readonly revision: number;
  readonly snapshot: WorkSnapshot;
  readonly subagentName: string;
}
```

The parent:

1. binds the update to a running child handle by `callId` and session id;
2. rejects stale revisions;
3. replaces the child snapshot on the owning action;
4. increments its own revision only when desired state changes;
5. republishes its snapshot upward when it is itself delegated;
6. rejects every child update after the action becomes terminal.

Terminal result delivery and work updates may race. Both orders must converge
to the same terminal parent graph. Child progress delivery is best-effort and
must not delay model execution or terminal settlement indefinitely.

The v1 payload is runtime-internal. Its shape should avoid assumptions that
would prevent later remote delivery, but v1 does not define public remote
capability negotiation.

## Initial Slack consumers

Slack is the proving ground, not part of the graph contract.

### Deterministic status renderer

The first consumer selects one compact line from the graph while preserving
current visible behavior where practical:

```text
Running the checkout reproduction…
```

For parallel work:

```text
Researching three approaches…
```

The renderer owns:

- human labels for known action kinds;
- truncation and safe argument selection;
- prioritizing blockers over active work;
- summarizing parallel children;
- clearing or superseding status after visible output;
- all Slack API behavior and presentation maintenance.

Reasoning-derived or model-narrated status can remain a separate Slack policy
while the graph is evaluated; raw reasoning does not need to enter the v1 work
graph.

### Hierarchical activity-message spike

The second consumer updates one Slack message from the same graph:

```text
Cold-start investigation

✓ Dependency analysis
  Found eager initialization

◐ Bundle analysis
  Running measurements

! Runtime analysis
  Waiting for access
```

This renderer validates that the graph contains enough information for the
motivating nested-work use case. It should support:

- parallel and nested local children;
- active, blocked, completed, failed, and cancelled states;
- stable in-place updates;
- completed-scope collapse;
- missing-message recovery;
- terminal settlement.

It may remain internal or experimental. The generic channel API should be
extracted only after the status and activity renderers demonstrate a stable
common input.

## PR stack

### PR 1 — Pure internal work graph

Add a pure reducer over existing authoritative lifecycle facts:

- turn and step lifecycle;
- runtime action requests and results;
- child dispatch and settlement;
- input, authorization, and approval waits;
- cancellation and failure.

Establish stable action identity, planless step grouping, replay determinism,
terminal precedence, and scope compaction. Add no visible behavior or public
API.

Acceptance criteria:

- planless turns reduce identically across replay;
- incremental action request events converge on runtime action state;
- parallel actions retain independent `callId` identity;
- blockers attach and settle without losing their owner;
- late events cannot rewrite terminal actions;
- completed step detail collapses deterministically.

### PR 2 — Durable local-child composition

Publish versioned local-child snapshots and compose them into the parent graph.

Acceptance criteria:

- two parallel children remain independent;
- a nested child update bubbles one parent at a time;
- stale revisions are ignored;
- terminal result/update races converge;
- cancellation settles descendant work;
- propagation failure does not fail an active turn;
- no public remote wire contract is introduced.

### PR 3 — Internal Slack status consumer

Render the work graph through Slack's existing compact status surface. Preserve
visible defaults where practical and keep every Slack-specific concern inside
the Slack package.

Acceptance criteria:

- simple tool calls show useful deterministic status;
- parallel children collapse to compact copy;
- blockers outrank generic running status;
- terminal and visible-output behavior remains correct;
- the work graph contains no Slack fields.

### PR 4 — Internal Slack activity-message renderer

Add an internal or experimental replaceable message that renders hierarchical
work.

Acceptance criteria:

- simple planless turns are not blank;
- parallel and nested children update stable rows in place;
- completed scopes collapse while failures remain legible;
- blockers render distinctly from running work;
- terminal state settles the message;
- the renderer requires no child stream attachment outside framework snapshot
  propagation.

### PR 5 — `reportProgress()` and automatic MCP adaptation

After the graph and propagation path are proven, add action-local authored
reports:

```ts
interface ProgressReport {
  readonly message?: string;
  readonly progress?: number;
  readonly total?: number;
  readonly unit?: string;
}

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

`ToolContext.callId` supplies ownership. MCP `notifications/progress` enters the
same internal action-report path by privately correlating `progressToken` to the
active eve call.

This PR owns the hard durability semantics:

- define exactly what awaiting `reportProgress()` guarantees;
- identify updates by call, execution attempt, and revision;
- reject reports from stale attempts and terminal actions;
- define whether numeric progress must be monotonic within one attempt;
- coalesce rapid reports without losing the latest accepted snapshot;
- prevent terminal settlement from being followed by a late resurrection;
- bound propagation volume through nested parents;
- remove MCP correlation state on settlement.

Acceptance criteria:

- report, crash, and retry do not regress or duplicate action state incorrectly;
- a late report after terminal settlement is rejected;
- rapid reports coalesce to the latest accepted report;
- parallel tools report independently;
- a nested child's report reaches the root renderer;
- MCP progress reaches the same renderer without authored eve-specific code;
- MCP servers that emit no progress retain useful lifecycle fallback.

This is the first PR likely to expose a new authored API and therefore needs
public documentation, focused integration coverage, extension compatibility
updates, and a changeset.

## Follow-on hypotheses

The following are deliberately outside the first five PRs.

### Structured plans

The framework todo is model-authored intent, not execution truth. A future
change may add stable item ids, plan title, description, and merge-by-id, then
attach an optional plan beside the observed step ladder:

```ts
interface ProgressPlan {
  readonly id: string;
  readonly title?: string;
  readonly items: readonly ProgressPlanItem[];
}
```

No action-to-plan-item relationship should be inferred without an explicit
protocol field.

### Generic channel API

After two Slack consumers prove a stable input, extract the smallest generic
channel hook from their common needs. Do not commit to a public
`defineChannel({ progress() {} })` shape before that evidence exists.

### Public observation

A future `progress.updated` hook or client event may expose snapshots to authored
observers and web clients. Publishing the graph creates a durable protocol
commitment and should follow stabilization.

### Remote child capability

Remote agents eventually need capability negotiation or a coarse compatibility
adapter. The local-child protocol should remain transportable, but v1 does not
publish a remote wire format.

### Partial-output projection

Streaming tool output may later project into `ProgressReport`. The full
`action.partial` stream remains independently valuable and should not be
replaced by progress.

### Model summaries

A channel may eventually use a cheap model to summarize a bounded graph for its
audience. Summarization is presentation-only, cached by graph fingerprint, and
must fall back to deterministic copy. It never replaces canonical child state.

### Liveness

Remote liveness, elapsed-time decoration, and stall policy are operational
concerns distinct from semantic work phase. Lack of recent activity must not be
interpreted automatically as failure.

## Verification strategy

Choose the narrowest test tier for each invariant:

- pure reducer and compaction tests at the unit tier;
- in-memory child composition and race tests at the integration tier;
- workflow retry, cancellation, and durable inbox behavior at the scenario
  tier where necessary;
- deterministic fixture coverage for final Slack integration behavior.

The implementation stack is successful when:

- planless root work reduces deterministically;
- nested local work composes without channel-side child stream readers;
- stale or late updates cannot overwrite terminal state;
- status and activity renderers consume the same graph;
- the graph remains free of Slack state;
- ordinary tools remain useful without authored progress reports;
- PR 5 can add precise reports without changing graph ownership or child
  propagation semantics.

## Out of scope

- a custom agent reducer;
- authored retention counts;
- inferred action-to-plan-item ownership;
- raw reasoning in the work graph;
- exactly-once external message creation;
- public remote-agent progress negotiation in v1;
- automatic model summarization in canonical reduction;
- replacing the durable event stream with the live work graph.
