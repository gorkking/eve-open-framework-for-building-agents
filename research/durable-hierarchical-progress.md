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

### Progress reducer

A reducer folds facts into durable desired state. It must be deterministic and
side-effect free so workflow retries produce the same result.

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

Start with the constrained internal projection to establish semantics. Do not
expose a public reducer until the tree survives nested delegation without
channel-specific fields.

### Channel reconciler

The root channel receives a complete desired projection and reconciles it with
external state. It owns effectful and presentation-specific concerns:

- choose an indicator, one updated message, multiple posts, or blocks;
- create and remember external resource ids;
- update or clear prior presentation;
- truncate, throttle, debounce, and refresh according to platform limits;
- decide how completed children remain visible.

The reconciler's durable channel state contains external ids and the last
successfully rendered projection fingerprint. Reducer state must not contain
those values. Reconciliation is best-effort and must not fail the agent turn.

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
