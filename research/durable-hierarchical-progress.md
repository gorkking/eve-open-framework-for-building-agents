---
issue: https://github.com/vercel/eve/issues/1673
status: proposed
last_updated: "2026-08-14"
---

# Durable hierarchical progress

## Summary

eve should maintain a durable, framework-owned work graph for the active turn
and its delegated work. The graph should derive from authoritative runtime
lifecycle state, compose through child sessions, and remain independent of
channel effects. A root channel can render a selected view without rebuilding
execution ownership from raw streams.

```text
runtime lifecycle + child observations
                 │
                 ▼
        durable work graph
                 │
                 ▼
     channel-specific presentation
```

The implementation experiment has validated the main boundary:

- ordinary turn, step, action, blocker, and local-child state can reduce into a
  useful graph without authored progress calls;
- local child snapshots can be read without forwarding every child event;
- Slack can render compact status and hierarchical activity from the same graph;
- observation polling must remain separate from the parent's terminal-result
  control loop;
- channel presentation state needs explicit ownership across parent and monitor
  workflows.

Since the original proposal, eve also gained child-authored `task_update`
notifications for background tasks in [PR #2113](https://github.com/vercel/eve/pull/2113).
Those updates provide immediate semantic milestones over the existing task
transport. They complement rather than replace the observed work graph: a task
update says what the child chooses to report, while the graph records what the
runtime can verify.

The next design step should combine those sources before adding a broad public
progress API. In particular, this proposal no longer recommends introducing
`ctx.reportProgress()` as the immediate next layer.

## Problem

Channels currently infer progress independently from low-level stream events.
Slack, for example, can derive status text from turn start, reasoning, assistant
narration, action requests, visible output, and terminal events. That state is
implicit and channel-local.

Delegated sessions make the gap clearer. A parent owns a child action and
receives its terminal result, but the child's ordinary step and action lifecycle
does not appear in the parent session stream. A channel that wants to show
parallel delegated work must otherwise attach to child streams and reconstruct
ownership, ordering, and terminal state itself.

The missing primitive is durable work ownership:

> What work is currently active, blocked, or terminal, and what direct child
> work does it own?

A free-form status message alone cannot answer that question. Conversely, an
observed graph cannot always explain the child's semantic goal. eve needs a
clear boundary between observed execution facts, child-authored milestones,
and presentation.

## Design principles

1. **Observed work is the core.** The graph records runtime truth: the active
   turn, model steps, actions, blockers, and delegated children.
2. **Authored updates annotate observed work.** A child milestone may add useful
   text to its owning action, but it does not redefine lifecycle phase.
3. **Plans are separate intent.** A todo list may attach to a turn, but it does
   not define execution truth or imply action-to-plan-item edges.
4. **The graph is desired state, not history.** The durable event stream remains
   the complete audit trail.
5. **Reduction is framework-owned.** Agents do not customize graph invariants,
   child revisions, retention, or terminal precedence.
6. **Children own their projections.** Parents read versioned child state rather
   than ingesting every raw child event.
7. **Control and observation stay separate.** Terminal results, input, and
   authorization use immediate control paths. Routine child observations must
   not destabilize or wake the parent turn for every step.
8. **Presentation belongs to channels.** The graph contains no Slack blocks,
   message IDs, API operations, or presentation timers.
9. **Blockers are first-class.** Waiting for input, authorization, or approval is
   authoritative state, not an absence of progress.
10. **Terminal state wins.** Late, replayed, or polled updates cannot resurrect
    settled actions or channel activity.

## Proposed core semantics

### Session-relative work graph

The initial graph should remain small and internal. A session-relative shape is
sufficient; recursive child snapshots provide hierarchy without requiring a
public root wrapper:

```ts
type WorkPhase = "queued" | "running" | "blocked" | "completed" | "failed" | "cancelled";

interface WorkGraph {
  readonly revision: number;
  readonly turn?: WorkTurn;
}

interface WorkTurn {
  readonly id: string;
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
  readonly kind: "tool-call" | "load-skill" | "subagent-call" | "remote-agent-call";
  readonly name: string;
  readonly phase: WorkPhase;
  readonly detail?: string;
  readonly update?: WorkUpdate;
  readonly child?: {
    readonly sessionId: string;
    readonly work?: WorkGraph;
  };
}

interface WorkUpdate {
  readonly message: string;
  readonly revision: number;
  readonly source: "task-update";
}

interface WorkBlocker {
  readonly id: string;
  readonly kind: "input" | "authorization" | "approval";
  readonly phase: "blocked" | "completed" | "cancelled";
  readonly ownerCallId?: string;
}
```

The exact serialization and public names are not committed here. The graph
should remain internal until its lifecycle and presentation consumers
stabilize.

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
            ├── discover [completed]
            └── inspect [running]
```

Actions observed under the same `stepIndex` are siblings. A delegated action
owns its child graph. Tool inputs may contribute bounded deterministic detail
when a renderer-safe field is known, but the graph must not expose arbitrary
arguments or infer future work.

The graph does not infer a plan, user intent, or a relationship between an
action and a hypothetical task.

### Blocked work

A blocker belongs to the turn and may identify its owning action:

```text
turn [blocked]
├── update feature flag [blocked]
└── approval [blocked]
    └── owner: update feature flag
```

When the blocker resolves, the same blocker settles and the turn resumes. It is
not replaced with an unrelated status.

### Scope compaction

The live graph is not an audit log:

- retain active and blocked actions;
- retain completed actions while their surrounding work remains useful to the
  active presentation;
- collapse completed step internals as the turn advances;
- retain failure or cancellation detail needed to explain the outcome;
- retain active child graphs until their owning action settles;
- remove the completed turn from live session state after settlement;
- preserve the full sequence in the existing durable event stream.

The implementation experiment retained more completed child actions than this
minimal policy so Slack could show observed stage history. The final compaction
rule should be based on bounded size and renderer needs, not on the fixture's
three-stage shape.

## Child observation and control

### Local child work projections

A local child writes its latest committed `WorkGraph` to a child-owned,
namespaced workflow stream. A reader resolves the child session through the
parent's running handle and reads the latest committed snapshot.

```text
child turn workflow
  └── commit work graph → child eve.work projection

parent control path
  └── wait for terminal/input/auth inbox messages

sibling work monitor
  ├── read direct child eve.work tails
  ├── compose newer snapshots
  ├── render changed desired state
  └── sleep for a bounded interval
```

This structure follows from a failed experiment. Racing a durable timer against
the parent turn's inbox iterator introduced competing replay paths and prevented
the turn from reliably advancing after both child results were ready. Polling in
a sibling workflow leaves the existing result-wait protocol unchanged.

The monitor is observational:

- it does not own terminal child results;
- it does not mutate the parent's turn cursor;
- it adopts only newer child revisions;
- it stops when observed children are terminal;
- polling failure must not fail the parent turn.

The prototype uses a ten-second interval. That value is an operational default,
not part of the graph contract.

### Background task updates

Merged background-task support gives task-owned children an immediate semantic
path:

```text
task-owned child
  └── task_update({ message })
        └── local task inbox or remote callback
              └── deduplicated parent notification
```

A task update should annotate the matching child action or task node. It should
not change the action's phase, append unbounded history, or replace framework-
observed lifecycle facts.

The two sources have different guarantees:

| Source        | Meaning                            | Delivery                 | Coverage                             |
| ------------- | ---------------------------------- | ------------------------ | ------------------------------------ |
| Work snapshot | Framework-observed lifecycle state | Bounded local polling    | Local delegated sessions             |
| `task_update` | Child-authored semantic milestone  | Immediate task transport | Task-owned local and remote children |

A practical next integration should use immediate task updates when available
and retain snapshot polling as reconciliation and as a fallback for ordinary
local subagents. The framework should coalesce repeated authored updates and
bind them to stable task or call identity.

### Terminal precedence

Control and presentation can still race. The following sequence is valid:

```text
parent terminal renderer deletes or settles activity
late monitor poll attempts an update
channel rejects or ignores the stale update
```

The channel must fence terminal presentation. In the Slack experiment, the
parent owns creation and terminal deletion of the transient activity message;
the monitor may update an existing message but cannot recreate a missing one.
A general channel contract needs equivalent ownership without exposing Slack
message semantics in the graph.

## Slack as the proving ground

Slack is a consumer of the graph, not part of its contract.

### Compact status

The compact renderer selects one deterministic line from active work. It owns
human labels, truncation, blocker priority, parallel-child summarization, and
status clearing. Reasoning-derived status may remain a separate policy; raw
reasoning does not belong in the work graph.

### Hierarchical activity

The activity renderer maintains one transient Slack message with one native
`task_card` block per direct action or subagent. Child actions appear as
rich-text details:

```text
Researcher [in progress]
  ✓ discover
  ◐ inspect

Verifier [in progress]
  ✓ prepare
  ◐ validate
```

The experiment established several presentation constraints:

- native `plan` blocks and standalone `task_card` details may collapse when a
  whole message is replaced with `chat.update`;
- Slack does not expose client expansion state through Block Kit;
- standard section blocks remain the predictable always-expanded fallback;
- Slack's `chat.startStream`, `chat.appendStream`, and `chat.stopStream` task
  updates are a better candidate for native live agent progress than repeated
  full-message replacement, but adopting them changes response ownership and
  needs separate design;
- the parent must own terminal cleanup so a stale monitor cannot leave a live
  card after the final response.

The current activity renderer should remain internal while those tradeoffs are
evaluated. A generic public channel progress hook is premature.

## Revised rollout

### 1. Internal work graph

Reduce existing turn, step, action, blocker, delegation, cancellation, and
failure facts. Prove deterministic identity and terminal precedence with unit
tests.

### 2. Child-owned local projections

Write committed local child snapshots to a namespaced stream and support direct
latest-snapshot reads. Keep this layer independent of channels.

### 3. Isolated observation monitor

Run bounded polling in a sibling workflow. Do not race observation timers
against the parent control inbox. Prove replay, result delivery, cancellation,
and monitor settlement independently.

### 4. Slack consumers

Consume the same graph for compact status and hierarchical activity. Keep
message identity, Block Kit, API calls, fallback behavior, and terminal cleanup
inside Slack.

### 5. Task-update composition

Project merged `task_update` notifications onto the owning task or child action.
Use them for immediate semantic milestones while preserving observed graph phase
and bounded snapshot reconciliation.

Acceptance criteria:

- duplicate task updates do not append duplicate graph state;
- an update cannot revive a terminal task or action;
- a fast update that races terminal settlement converges on terminal state;
- local and remote task updates use the same annotation semantics;
- ordinary local subagents remain useful without authored updates;
- renderers can prefer a fresh semantic message without losing structured child
  lifecycle state.

### 6. Reassess authored tool progress

Do not add `ctx.reportProgress()` until task updates and streaming tool partials
have shown a missing authoring case. Preliminary tool results may already
provide a natural action-owned source for authored tools. MCP
`notifications/progress` still needs private `progressToken`-to-`callId`
correlation, attempt identity, coalescing, and terminal rejection.

If a common report shape remains necessary, design it from those proven sources
rather than adding a parallel side channel first.

## Follow-on hypotheses

### Structured plans

The framework todo is model-authored intent, not execution truth. A future
change may attach a structured plan beside the observed step ladder. No
action-to-plan-item edge should be inferred without an explicit protocol field.

### Generic channel API

Extract the smallest channel-neutral hook only after multiple channel consumers
or Slack presentation strategies prove a stable input and ownership model.

### Public observation

A future client event or hook may expose snapshots to authored observers.
Publishing the graph creates a durable protocol commitment and should follow
internal stabilization.

### Remote child observations

`task_update` covers semantic milestones for task-owned remote children, not a
complete remote work graph. Full remote observation still requires capability
negotiation or a coarse compatibility projection.

### Streaming Slack tasks

Slack's streaming task updates may avoid the collapse behavior caused by
`chat.update`. They also couple activity progress to a streaming response
message, so the design must define who starts and stops the stream, how replayed
updates deduplicate, and how the final response is delivered.

### Liveness

Elapsed time, remote liveness, and stall policy are operational concerns. Lack
of recent activity must not automatically imply failure.

## Verification strategy

Use the narrowest tier for each invariant:

- unit tests for pure reduction, compaction, child adoption, and Slack rendering;
- integration tests for in-memory child composition and task-update projection;
- scenario tests for workflow replay, monitor isolation, cancellation, and
  terminal races;
- deterministic fixture evals for final Slack behavior.

The design is successful when:

- planless root work reduces deterministically;
- nested local work composes without channel-side child stream attachment;
- the parent control path remains unchanged by observation polling;
- authored task updates annotate rather than replace observed state;
- stale child or monitor updates cannot overwrite terminal state;
- compact and hierarchical renderers consume the same graph;
- the graph remains free of Slack state;
- ordinary tools and subagents remain useful without authored progress calls.

## Out of scope

- a custom agent reducer;
- authored retention counts;
- inferred action-to-plan-item ownership;
- raw reasoning in the work graph;
- exactly-once external message creation;
- a public remote work-graph protocol;
- automatic model summarization in canonical reduction;
- replacing the durable event stream with the live work graph.
