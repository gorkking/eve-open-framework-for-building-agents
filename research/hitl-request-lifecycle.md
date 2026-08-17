---
issue: https://github.com/vercel/eve/issues/1224
status: proposed
last_updated: "2026-08-17"
---

# HITL requests must not wedge sessions

## The problem

Today, a user can send a message while an approval is waiting and get no useful
response.

```text
approval waits
  -> user sends a message
  -> eve hides the message in deferredStepInput
  -> eve waits for the approval again
```

No model call runs. If nobody answers the approval, the message stays hidden.
The session looks broken. The same defect exists one layer down: while a
connection-authorization challenge is open, the session driver reads only the
callback hook, so ordinary deliveries are never admitted at all.

Both wedges are one bug wearing two coats: **an obligation encoded as a blocked
continuation** — "the code is waiting on X, therefore only X can arrive" —
instead of as data the session carries while remaining receptive. The
mitigations ([#1830], [#1868]) removed the two blocked continuations. This
document defines the end state they were aiming at: a state machine in which
every open request, challenge, and prompt is a row in durable state, every
delivery is interpreted against those rows by one pure function, and nothing
the session receives is ever silently consumed.

Three rules carry over unchanged from the original proposal:

1. **Pending requests never block the conversation.** A message runs as a
   normal turn. The request just stays unanswered.
2. **Do not steal someone else's request.** A message cannot approve, deny,
   cancel, dismiss, or replace an existing HITL request.
3. **Show request closure.** Emit `input.requested` before waiting, then emit a
   settlement event or `input.dismissed` when the request stops being usable.

## Who owns what

- The **owner session** stores and settles the request. A child agent owns its
  own request even when a parent shows that request to the channel.
- The **originating actor** is the user whose turn created the request.
- The **current actor** is the user sending the new message or response.

These are different identities. Session admission does not grant permission to
change a HITL request.

## State model

### Obligations

An **obligation** is one open item the session owes an answer to. Four kinds:

- **Approval** — human consent for one tool call.
- **Question** — an `ask_question` prompt.
- **Limit** — a session-limit continuation prompt, carrying a monotonic
  `generation`.
- **Challenge** — a connection-authorization challenge (OAuth credentials,
  not consent).

Each obligation is a small state machine. Terms:

- **Open:** the obligation can still be answered.
- **Settled:** an accepted response closed it.
- **Dismissed:** it closed without an accepted response.
- **Completed:** terminal state of a challenge (challenges are not input
  requests; their terminal vocabulary is the authorization outcome).

```text
Approval(id)   open ──accepted allow──────────▶ settled(allowed)
               open ──accepted deny───────────▶ settled(denied)
               open ──authenticated cancel────▶ settled(cancelled)
               open ──owning turn cancelled───▶ dismissed(cancelled)
               open ──session ended───────────▶ dismissed(session-ended)
               open ──rejected candidate──────▶ open        (event only)

Question(id)   open ──accepted answer─────────▶ settled(answered)
               open ──originating-actor msg───▶ dismissed(superseded)
               open ──cancel / session end────▶ dismissed(…)

Limit(gen)     open ──continue────────────────▶ settled(continued)
               open ──stop────────────────────▶ settled(stopped)
               open ──any message─────────────▶ dismissed(superseded),
                                                Limit(gen+1) opens
               // a response naming gen-1 is rejected as stale

Challenge(id)  open ──callback────────────────▶ completed(authorized |
                                                declined | failed)
               open ──deadline────────────────▶ completed(timed-out)
               open ──cancel / session end────▶ completed(cancelled)
               completed ──late callback──────▶ completed   (event only)
```

**Single winner.** Every obligation has at most one terminal transition. The
identity of a competing attempt is its **candidate**: eve derives
`candidateId` from `{ requestId, deliveryId }`, where `deliveryId` is assigned
by the server at admission — the HTTP API gains no new request field. A
workflow-level redelivery of the same admitted delivery reuses the candidate;
a new delivery creates a new candidate and participates in the obligation's
atomic single-winner transition. After one candidate wins, later candidates
are stale and later dismissals are no-ops. A client-supplied idempotency key
is possible later as an optional, additive field.

**Adjudication.** For approvals, the response policy decides on a correlated
candidate: accept or reject. An accepted candidate settles the obligation with
the outcome its value carries (`allowed` or `denied`). A rejected candidate
never settles: the obligation stays open for an authorized responder, and the
rejection becomes turn context so the agent can react. Allow uses the tool's
response authorizer. Cancel requires an authenticated actor and bypasses the
Allow authorizer. Question answers and Limit Continue/Stop use their owning
tool or runtime gate. Policy throw or timeout is not an adjudication.

- **Response:** a structured `InputResponse` naming an open `requestId`. Only
  channels construct responses, from an explicit user interaction with the
  rendered request — a button, select, modal, or a channel-owned reply mapping
  where the channel knows exactly which prompt the user saw.
- **Message:** any delivery content that is not a response. The runtime never
  reinterprets message text as a response. Whether a message semantically
  relates to an open obligation is the agent's job inside the turn.

### Groups and continuations

Obligations raised by one park form a **group**, and every group carries a
**continuation** that fires exactly once when the group closes ordinarily:

| Group         | Members                                         | Continuation on ordinary closure                                                                        |
| ------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| ApprovalBatch | approvals and questions from one assistant turn | restore the withheld model output once, append every member outcome, run each allowed tool exactly once |
| AuthGroup     | challenges from one park                        | re-drive the blocked turn with every callback result available                                          |
| LimitPrompt   | one Limit(gen)                                  | grant a fresh budget window (continued) or cancel the turn (stopped)                                    |

A group becomes eligible for ordinary closure exactly when every member is
terminal. The ledger then durably claims its continuation once; terminal
obligations and groups remain as tombstones until the session ends so late and
duplicate inputs can be classified without a second stale-response mechanism.
Rules:

- Settling one member of a multi-member group leaves its siblings open and
  does **not** claim the continuation (the withheld output appears zero times
  in committed history until closure).
- **Forced closure** — turn cancellation or session end dismissing the
  members — suppresses the continuation instead of claiming it: no restored
  output, no batch tool, no model call.
- Tools whose approval settled as denied or cancelled do not run. Rejected
  candidates do not change a member's later eligibility.
- Tool dispatch rechecks turn and session cancellation after the continuation
  wins and before execution.

ApprovalBatch and AuthGroup are deliberately the same shape. Today they are
two mechanisms (batch splice vs. driver-side callback counting); the end state
needs one, which also fixes multi-challenge semantics for free: each callback
settles its own challenge (with its own events), and the blocked turn resumes
once, when the last challenge completes.

### Projections

A parent session that surfaces a child-owned request runs a second, simpler
machine per request: a **route**.

```text
Route(requestId)  absent ──child raises───────▶ active     (parent re-emits
                                                            input.requested)
                  active ──child closes───────▶ dropped    (parent re-emits the
                                                            closure, scope:
                                                            projection)
                  active ──route unusable─────▶ dropped    (input.dismissed,
                                                            scope: projection,
                                                            reason: route-lost)
                  dropped ──response arrives──▶ dropped    (reject stale;
                                                            never resumes the
                                                            child)
```

The projector never settles anything. It mirrors: responses forward down with
the verified responder unchanged; the child evaluates its own response policy
and remains the only owner. Routes accumulate per request — a child raising a
fresh batch must not drop routes for its still-open earlier requests. Owner
events use the request's originating turn coordinates; projection events keep
those coordinates and change only `scope`.

### Scheduler

```text
Receptive ──delivery admitted──▶ TurnActive ──turn ends──▶ Receptive
Receptive ──cancel / expire / session end──▶ terminal
```

That is the whole scheduler. There is no `AwaitingApproval` and no
`AwaitingAuthorization` — those were the two wedges. **Admission never
blocks**: every delivery is admitted, interpreted, and answered with
observable events. Deliveries that arrive during `TurnActive` buffer in
arrival order and are interpreted at the next boundary. Admission guarantees
interpretation, not a model call — which deliveries invoke the model is
decided per transition row (invariant 2).

The one licensed irregularity is an open `Limit(gen)`: it changes what a
_message_ means (supersede-and-re-prompt instead of a model call), because its
entire purpose is to stop spend. Even then the delivery is admitted and
produces observable output — nothing is invisibly buffered.

### Input alphabet

External deliveries — one arrival-ordered stream:

| Input                                               | Carries                                                 |
| --------------------------------------------------- | ------------------------------------------------------- |
| `Message(actor, text, context?)`                    | plain content; never reinterpreted as a response        |
| `Responses(actor, [{requestId, optionId \| text}])` | one or more structured responses                        |
| `Compound(actor, responses, message)`               | both in one delivery; each part processed exactly once  |
| `Callback(name, params)`                            | a connection-authorization callback                     |
| `CancelTurn`, `EndSession`                          | controls normalized by the turn adapter                 |

Timers: `Deadline(challengeId)` and `SessionDeadline` are first-class inputs,
not artifacts of a wait.

Turn outcomes — outputs of `TurnActive`, not deliveries:

| Outcome                                      | Effect on state                                                           |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| raises `{approvals*, questions*}`            | append an ApprovalBatch (mixed membership allowed)                        |
| raises challenges                            | append an AuthGroup                                                       |
| hits the budget gate                         | open `Limit(gen)`                                                         |
| dispatches runtime actions alongside a batch | both persist; every HITL request is exposed before dispatching or waiting |
| completes / fails / cancelled                | closure inputs to open groups                                             |

Child events (parent side): child raises a request, child closes a request,
route becomes unusable.

Guard axes — parameters of transitions, not new inputs: the actor relation
(originating / other / anonymous), the candidate identity, and timing (which
is fully encoded by obligation state).

### Interpretation

One pure function interprets every HITL input:

```text
interpretHitl(state, input) -> { nextState, effects }

input   = delivery | timer | turn-outcome | child-event | control
effects = one ordered list of emit | restore-group | execute-tool |
          run-model | forward-response | terminate-turn
```

The executor persists `nextState` before performing the effects in order.
Drivers schedule; they never interpret. Invariants:

1. **Admission never blocks.** Obligations are data, never control flow: no
   blocked continuation anywhere, no wait source narrowed by open
   obligations. The scheduler is always receptive; a delivery arriving during
   `TurnActive` buffers in durable arrival order — buffering is ordering,
   never refusal.
2. **Admission does not necessarily invoke the model.** Admitting a delivery
   guarantees interpretation and observable events, not a model call. A model
   call happens in exactly two ways: a `run-model` effect — a message turn,
   or a context turn carrying a rejected approval/question attempt (the
   `reject-*` rows) — or a claimed continuation resuming the parked turn at
   group closure. Everything else is absorbed without one: settling a member
   whose siblings stay open, a deduplicated redelivery, and every `Limit`
   transition except Continue (supersede re-prompts, Stop terminates, a stale
   generation is dropped).
3. **Every invoked model turn receives a safe projection of open
   obligations.** The transcript handed to the model (a) contains the
   withheld output of an open group zero times, (b) contains no fabricated
   response, result, or consent for an unsettled obligation, and (c) carries
   attempts that settled nothing as explicit synthetic context messages,
   never as settlements. An obligation enters history only through its real
   settlement or dismissal outcome at group closure.
4. **A newly raised approval is checked against open approval intent before
   append.** Approval intent is the tool's approval key —
   `approvalKey(toolInput)`, defaulting to the tool name. A park raising an
   approval whose intent matches an open approval must not open a second
   obligation for that intent; one settlement adjudicates one intent once
   (`owner.batch.park.dedupe-open-intent`).
5. **One arrival-ordered delivery stream.** Callbacks, messages, responses,
   and controls surface in one order; interpretation order is deterministic
   by construction, including under workflow replay.
6. **Single winner per obligation.** Later candidates are stale events.
7. **Continuations fire at most once.** Their durable state moves from
   `pending` exactly once, to `claimed` for ordinary closure or `suppressed`
   for forced closure.
8. **State before effects.** The executor persists the complete next state
   before emitting events, restoring output, running tools or models, forwarding
   a response, or terminating a turn.
9. **No silent consumption.** Every admitted delivery yields at least one
   observable event: `message.received`, a settlement, a rejection, a
   dismissal, or an authorization event. When a rejected approval or question
   attempt does start a turn, its input is the event context — who attempted
   what, and why it did not settle — so the agent can respond in-channel.
   Retries of the same delivery are deduplicated at admission and yield
   nothing new. Whether a delivery also invokes the model is invariant 2, not
   this one.
10. **Composite states add no cases.** The transition catalog for a session
    with approvals _and_ challenges open is the row-wise union of the
    catalogs for each alone. If a change ever needs a case that is not such a
    union, the encapsulation is broken. This is the standing review test for
    any future HITL change.

A channel that renders requests as text — SMS, a comment thread — may map an
explicit reply to a structured response in its adapter, because it knows which
prompt the user saw and which reply targets it. That mapped reply is a
response with full attribution, identical to a button click. The runtime
contract stays structured-only. Future work: an opt-in NLU step may classify a
plain reply into a structured response; its input is restricted to the
verified sender's message and the rendered request — never the agent's ambient
context, so injected tool output cannot forge consent.

## API changes

### Stream events

Events are the observable trace of transitions — one vocabulary, not two:

| Transition                                                                            | Event                                                    |
| ------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| obligation opens                                                                      | `input.requested` / `authorization.required`             |
| candidate accepted, obligation settles                                                | `input.responded`                                        |
| candidate rejected (invalid, stale, unauthorized, policy-failed, candidate-cancelled) | `input.response.rejected`                                |
| candidate parked on separate authorization                                            | `input.response.pending(reason: authorization-required)` |
| obligation dismissed (superseded, cancelled, session-ended, route-lost)               | `input.dismissed`                                        |
| challenge completes                                                                   | `authorization.completed`                                |
| callback after completion                                                             | `authorization.callback.rejected(reason: stale)`         |

All input lifecycle events identify one obligation:

```ts
type InputLifecycleData = {
  requestId: string;
  scope: "owner" | "projection";
  sequence: number;
  stepIndex: number;
  turnId: string;
};

type InputResponseLifecycleData = InputLifecycleData & {
  candidateId: string;
  responder: {
    authenticator: string;
    issuer?: string;
    principalId: string;
  } | null;
};

type InputRespondedData = InputResponseLifecycleData & {
  response: InputResponse;
  outcome: "allowed" | "denied" | "cancelled" | "answered" | "continued" | "stopped";
};

type InputResponseRejectedData = InputResponseLifecycleData & {
  reason: "invalid" | "stale" | "unauthorized" | "policy-failed" | "candidate-cancelled";
};

type InputResponsePendingData = InputResponseLifecycleData & {
  authorizationId: string;
  reason: "authorization-required";
};

type InputDismissedData = InputLifecycleData & {
  reason: "superseded" | "cancelled" | "session-ended" | "route-lost";
};
```

Authorization lifecycle events carry one `authorizationId`, the verified actor
or null, and the blocked operation identity. `authorization.required`, its
callback, and `authorization.completed` use that ID.

### Wire compatibility

The contract is implementable without breaking any existing consumer. The
rules, in order of strictness:

**Unchanged — guaranteed.** No existing event type changes shape or meaning:
`input.requested`, `message.received`, `session.waiting`, `action.result`,
`turn.*`, and `session.*` stay byte-compatible. `InputRequest` and
`InputResponse` wire shapes are unchanged. The HTTP API gains no new required
field on create, continue, stream, or cancel. Continuation tokens, session
IDs, and NDJSON framing are untouched.

**Additive — new events and fields only.** All net-new wire schema lands in
one stage (lifecycle events) behind one stream-version bump. Existing clients
ignore unknown event types — the default reducer returns state unchanged
([`message-reducer.ts`](../packages/eve/src/client/message-reducer.ts#L286-L287))
— so old clients render nothing new but never break. `authorizationId` is an
optional added field on existing authorization events. `cancelled` is an
additive `AuthorizationOutcome` value.

**One settlement family.** If PR #1368's settlement events land first,
`input.responded` is that family generalized to every request kind — not a
competing event. Exactly one settlement event family may exist on the wire.

### Durable state

**Durable state.** The pending-batch collection shipped in [#1868] with a
read shim for the legacy singleton key; the remaining state changes (candidate
records, limit generations, auth groups) ride the documented snapshot
versioning convention. Legacy `deferredStepInput` content — messages wedged
behind an approval before the mitigation — releases as an ordinary message
turn on the first delivery after upgrade.

### Transport

**Transport consolidation — deliberately breaking, scoped.** The dedicated
authorization hook (`${sessionId}:auth`) is a transitional artifact of the
removed exclusive wait: callbacks are already payload-discriminated
(`authorizationCallback`) and classified at the turn step, so the end state
delivers them through the session's one command stream and deletes the
window-gating machinery. Cost: challenge URLs minted before the cutover embed
the old hook token and would 404; ship either a one-release token alias or
accept the break for in-flight challenges under the pre-1.0 policy.

### Behavior break

**Deliberately breaking, behavior not wire.** Runtime text matching is
removed: plain `approve` stops settling approvals through the resolution path
(`owner.approval.message.run-open`). `resolveTextToResponses` remains exported
for channel adapters that render prompts as text and own their reply mapping.
Documented behavior change (`docs/tools/human-in-the-loop.md`), shipped with
its docs update in the same stage.

## Data flow

Every label below names one construct; target-state constructs are marked.

| Label          | Construct                                                                                                                              |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| channel POST   | `POST /eve/v1/session/:id` in the [eve channel](../packages/eve/src/public/channels/eve.ts)                                            |
| callback route | [`handleConnectionCallbackRequest`](../packages/eve/src/runtime/connections/callback-route.ts)                                         |
| inbox          | [`SessionCommandInbox`](../packages/eve/src/execution/session-command-inbox.ts)                                                        |
| driver         | [`runDriverLoop`](../packages/eve/src/execution/workflow-entry.ts)                                                                     |
| turn step      | [`turnStep`](../packages/eve/src/execution/workflow-steps.ts)                                                                          |
| interpreter    | `hitl/interpret.ts` (target; today split across `resolvePendingInput`, stale conversion, limit resolution, callback extraction) |
| store          | `hitl/obligations.ts` (target; today `pending-input-batches`, `pendingAuthorization`, the limit-prompt batch)                   |
| executor       | tool-loop transcript assembly, tool execution, model calls                                                                             |

### Call graph

Arrows are calls; annotations are the data crossing the edge.

```text
channel POST ──channel auth──▶ resumeHook ──DeliverPayload──────────▶ inbox
callback route ──param projection──▶ resumeHook ──authorizationCallback──▶ inbox   (stage 4)
inbox ──SessionInboxPayload──▶ driver ──admit / dispatch──▶ turn step
turn step ──(load state, normalize input)──▶ executeHitl
executeHitl ──(state, input)──▶ interpreter ──decision──▶ executeHitl
decision.nextState ──▶ store          (persist before effects; only state writer)
decision.effects ──in order──▶ executor
                               (emit | restore output | run tool/model | forward | terminate)
executor outcome ──turn-outcome input──▶ executeHitl
```

The driver never sees obligation state; the interpreter never performs a side
effect; the store never decides. Today each of those sentences is false in at
least one module — see [Consolidation](#consolidation-one-interpreter).

### Canonical walks

Data at each step for the three flows that historically wedged or clobbered.

**Message while an approval is open** (`owner.approval.message.run-open`):

```text
delivery         = Message(actor B, "what's the status?")
store.read()     = groups: [Batch{ A1: open }]
interpret        ⊢ no correlated candidate; not limit-gated
decision.state   = groups: [Batch{ A1: open }] // A1 untouched, still answerable
decision.effects = [emit(message.received),
                    run-model(message)]        // model runs WITHOUT withheld output
```

**Late accepted response** (`owner.approval.response.settle-allow-after-turns`):

```text
delivery         = Responses(actor A, [{ requestId: A1, optionId: allow }])
store.read()     = groups: [Batch{ A1: open }, withheldOutput W]
interpret        ⊢ candidate c = {A1, deliveryId}; policy accepts; A1 is the last open member
decision.state   = Batch{ A1: settled(allowed), continuation: claimed }
decision.effects = [emit(input.responded(A1, c, responder A)),
                    restore-group(Batch), execute-tool(call-1), run-model(resume)]
```

**Authorization callback** (`owner.auth.callback.complete`):

```text
delivery         = Callback("weather", { code })
store.read()     = groups: [AuthGroup{ C1: open }]
interpret        ⊢ C1 matches; completes(authorized); last member closes the group
decision.state   = AuthGroup{ C1: completed(authorized), continuation: claimed }
decision.effects = [emit(authorization.completed(C1)),
                    restore-group(AuthGroup)] // re-drive with callback result
```

A stale variant of any walk changes only the decision: `interpret` finds the
terminal obligation, leaves `nextState` unchanged, and returns ordered effects
to emit the rejection and run a turn with the stale-attempt context.

## Transition catalog

Normative behavior, one entry per transition row. Anchors are stable
identifiers of the form `machine.obligation.input.outcome[-guard]`; evals and
implementation reference anchors, never positions.

Every entry uses the same fields:

- **Example** — one concrete walk of the row. Examples share one cast: an
  agent with an approval-gated `bash` tool and an `ask_question` tool, ACME
  Inc's OAuth connection, **Dana** (the originating actor), and **Sam**
  (another verified actor on the same channel).
- **Given** — machine state before the input, in ledger notation:
  `Batch B { A1: open }` is one group with one open approval; `W(B)` is that
  group's withheld model output, held in its continuation and absent from
  history until the group closes.
- **When** — exactly one input from the input alphabet, with its guard axes.
- **Then** — the transition, split into the three planes an input can touch:
  - **ledger** — obligation, group, candidate, and route state. "unchanged"
    means no obligation transitions; candidate bookkeeping may still record.
  - **history** — the committed model transcript. Only three things ever
    append here: (a) delivered user content, (b) restored withheld output
    plus member-outcome tool-result parts and each allowed tool's real result
    at group closure, and (c) a **synthetic context message** —
    runtime-authored text carrying event context (a stale, rejected, or
    pending attempt) into the next model call. Events are not history and
    history entries imply no events.
  - **turn** — whether a model call runs, and with what input. "none" means
    the delivery is fully absorbed by ledger transitions and events
    (invariant 2).
- **Observed** — required protocol events and their relative order; ordinary
  turn events may appear between them unless the entry says the sequence is
  exact.

### owner.approval

#### owner.approval.response.settle-allow

- **Example:** Agent wants to run `bash rm -rf ./tmp`. Dana clicks Allow. The
  command runs and the agent reports its output.
- **Given:** `Batch B { A1: open }`, `W(B)` withheld. `A1` is the only open
  member; for open siblings see `owner.batch.response.settle-partial`.
- **When:** `Responses(originating actor, [{ A1, allow }])`, accepted by the
  tool's response policy.
- **Then:**
  - **ledger:** `A1 → settled(allowed)`; `B` closes; continuation
    `pending → claimed`.
  - **history:** append `W(B)` once, `A1`'s allowed outcome part, then the
    tool's real result. No synthetic messages.
  - **turn:** one — the claimed continuation runs the tool exactly once and
    resumes the model with the result.
- **Observed:** `input.responded` precedes `action.result`.

#### owner.approval.response.settle-allow-other-actor

- **Example:** Dana's turn raised the `bash` approval; Sam clicks Allow and the
  tool's response policy accepts Sam.
- Same as `settle-allow` with the current actor ≠ originating actor and the
  policy accepting them. Every plane is identical except the verified
  responder in `input.responded`.

#### owner.approval.response.settle-allow-anonymous

- **Example:** Allow arrives from a channel with no login (a bare webhook). eve
  settles it and reports `responder: null`.
- Same as `settle-allow` when the channel supplies no verified principal: eve
  treats the session as one actor for origin comparison and reports
  `responder: null`. The fallback never fabricates a verified principal for
  response policy.

#### owner.approval.response.settle-deny

- **Example:** Agent wants to run `bash git push --force`. Dana clicks Deny.
  The push never happens and the agent acknowledges it.
- **Given:** `Batch B { A1: open }`, `W(B)` withheld.
- **When:** `Responses(actor, [{ A1, deny }])`, accepted by the response
  policy.
- **Then:**
  - **ledger:** `A1 → settled(denied)`; `B` closes only when every sibling is
    terminal.
  - **history:** at closure, append `W(B)` once plus a denied outcome part
    for `A1`'s call. The tool never runs, so no result is fabricated.
  - **turn:** one at closure — the model resumes seeing the denial.
- **Observed:** `input.responded(outcome: denied)` precedes the rejected
  `action.result` for the tool call.

#### owner.approval.response.settle-allow-after-turns

- **Example:** The `bash terraform apply` approval sits open while Dana chats
  about other things for three turns, then clicks Allow — apply runs now, after
  those turns.
- **Given:** `Batch B { A1: open }`, `W(B)` withheld; history already extended
  by unrelated turns completed since `A1` was created.
- **When:** an authorized actor sends an accepted response.
- **Then:**
  - **ledger:** `A1 → settled(allowed)`; continuation claimed.
  - **history:** the intervening turns are untouched; `W(B)`, the outcome
    part, and the tool result append after them — restore appends at the
    closure position, never splices back.
  - **turn:** one — resume with the result.
- **Observed:** the restored assistant output follows the intervening turns in
  history; the obligation is no longer open.

#### owner.approval.response.settle-cancel

- **Example:** Dana clicks Cancel on the `bash` approval: the request closes as
  cancelled and nothing runs.
- **Given:** `Batch B { A1: open }`, `W(B)` withheld.
- **When:** an authenticated actor sends an explicit correlated Cancel
  (bypasses the Allow authorizer).
- **Then:**
  - **ledger:** `A1 → settled(cancelled)`; closure per siblings.
  - **history:** at closure, `W(B)` plus a cancelled outcome part; no tool
    result — the tool does not run.
  - **turn:** one at closure.
- **Observed:** `input.responded(outcome: cancelled)` appears once;
  `action.result` contains `{ code: "TOOL_EXECUTION_CANCELLED", approval:
{ requestId, status: "cancelled" }, tool: { result: "not_run" } }`.

#### owner.approval.response.settle-cancel-pending-candidate

- **Example:** Sam's Allow is parked on an ACME sign-in. Dana clicks Cancel
  first; Sam's OAuth callback lands later and is rejected as stale.
- **Given:** `A1` open with an authorization-required Allow candidate pending
  on an open challenge (`response.pend-authorization`).
- **When:** an authenticated Cancel settles `A1` before the candidate's
  callback; the callback then arrives.
- **Then:**
  - **ledger:** Cancel completes the challenge (`cancelled`) and settles
    `A1 → settled(cancelled)`; the later callback matches a completed
    challenge — no transition, the approval does not reopen.
  - **history:** the closure content of `settle-cancel`; the late callback
    appends nothing.
  - **turn:** one at closure; none for the late callback.
- **Observed:** `authorization.completed(outcome: cancelled)` precedes the one
  terminal `input.responded(outcome: cancelled)`; the later callback emits
  `authorization.callback.rejected(reason: stale)` with the same
  `authorizationId` and `candidateId`.

#### owner.approval.response.settle-race

- **Example:** Dana clicks Allow in the same instant Sam clicks Cancel. One
  click wins; the other is told it came too late.
- **Given:** `A1` open; two accepted candidates race — Allow vs authenticated
  Cancel, or two allowed responders.
- **When:** both deliveries arrive; single-winner serializes them.
- **Then:**
  - **ledger:** exactly one candidate takes the atomic terminal transition.
    The second candidate is interpreted against the settled tombstone and
    reduces to `owner.approval.response.reject-stale`.
  - **history:** the winner's closure content only; the tool runs at most
    once, and only when Allow wins and the group closes.
  - **turn:** the winner's closure resume; the loser follows the
    `reject-stale` row.
- **Observed:** exactly one `input.responded`; the loser emits
  `input.response.rejected(reason: stale)`.

#### owner.approval.response.reject-stale

- **Example:** Dana already approved and the command ran. Sam clicks Allow on
  the same card a minute later; the agent replies that it already ran.
- **Given:** `A1` terminal (its tombstone is retained); the owner session is
  active.
- **When:** `Responses(any actor, [{ A1, … }])` — including a byte-identical
  duplicate of the winning response arriving as a new delivery (new
  `deliveryId`, therefore a new candidate).
- **Then:**
  - **ledger:** unchanged; the candidate is recorded stale.
  - **history:** append one synthetic context message carrying the stale
    attempt — who attempted which request, and why it did not settle. No
    outcome part is replayed.
  - **turn:** one — a context turn on that synthetic message, so the agent
    can answer in-channel. No tool runs.
- **Observed:** `input.response.rejected(reason: stale)`, then model output,
  then `session.waiting`; no second tool execution.

#### owner.approval.response.reject-unauthorized

- **Example:** Sam clicks Allow, but the tool's policy accepts only Dana. The
  agent tells Sam who may approve.
- **Given:** `A1` open, `W(B)` withheld.
- **When:** a correlated response arrives and the response policy rejects the
  responder.
- **Then:**
  - **ledger:** `A1` stays open and answerable; the candidate is recorded
    rejected.
  - **history:** one synthetic context message with the rejection (verified
    responder, reason); `W(B)` stays out.
  - **turn:** one — a context turn, for example telling the responder who may
    approve. No tool runs.
- **Observed:** `input.response.rejected(reason: unauthorized)` with the
  verified responder, then a normal turn's model output, then
  `session.waiting`. No settlement or dismissal.

#### owner.approval.response.reject-policy-failed

- **Example:** Dana clicks Allow, but the response policy times out mid-outage.
  The agent asks Dana to try again.
- **Given:** `A1` open.
- **When:** a correlated Allow candidate reaches a response policy that throws
  or times out — infrastructure failure, not adjudication.
- **Then:** as `reject-unauthorized` with reason `policy-failed`: ledger open,
  one synthetic failure-context message, one context turn so the agent can
  tell the responder to retry.
- **Observed:** `input.response.rejected(reason: policy-failed)`, then model
  output, then `session.waiting`; no terminal event.

#### owner.approval.response.reject-invalid

- **Example:** A client sends `optionId: "yes"`, which is not an option on the
  request.
- **When:** a correlated response carries an unknown option ID or malformed
  value.
- **Then/Observed:** as `reject-policy-failed` with
  `input.response.rejected(reason: invalid)`.

#### owner.approval.response.pend-authorization

- **Example:** Dana clicks Allow, but allowing requires Dana to first sign in
  with ACME. The approval waits on that sign-in.
- **Given:** `A1` open; the tool's Allow requires a separate authorization
  flow.
- **When:** an Allow candidate arrives.
- **Then:**
  - **ledger:** a durable pending candidate bound to
    `{ candidateId, requestId, responder }`; a challenge opens, linked to that
    candidate; `A1` stays open. Duplicate delivery of the same `candidateId`
    returns the existing pending candidate and never opens a second
    challenge.
  - **history:** one synthetic context message carrying the
    pending-authorization state.
  - **turn:** one — a context turn while the candidate waits. No tool runs.
- **Observed:** `input.response.pending(reason: authorization-required)` opens
  a challenge linked to that candidate. After that challenge completes:
  `authorized` re-runs the response authorizer and emits `input.responded`,
  `input.response.pending`, or `input.response.rejected` from that result;
  `declined` → `rejected(unauthorized)`; `failed`/`timed-out` →
  `rejected(policy-failed)`; `cancelled` → `rejected(candidate-cancelled)`.

#### owner.approval.message.run-open

- **Example:** While the `bash` approval waits, Dana types the word `approve`
  as plain chat. Nothing settles; the agent answers and points Dana at the
  buttons.
- **Given:** `Batch B { A1: open }`, `W(B)` withheld.
- **When:** `Message(any actor, text)` — including text that resembles an
  option, like the plain word `approve`. The runtime never matches message
  text against open obligations.
- **Then:**
  - **ledger:** unchanged — `A1` stays open, owned, and answerable.
  - **history:** append the user message. `W(B)` stays out; no synthetic
    messages, no outcome parts.
  - **turn:** one — a normal message turn whose transcript is the safe
    projection (history without `W(B)`, invariant 3). If the text was in
    fact an answer, the agent handles it semantically and can tell the actor
    how to actually respond.
- **Observed:** `message.received`, model output, `session.waiting`; no
  request event of any kind.

#### owner.approval.message.no-retroactive-binding

- **Example:** Dana's "yes, go ahead" was sent before the approval card
  existed. It is never counted as consent for it.
- **Given:** a `Message` was admitted and buffered before `A1` existed; `A1`
  is created before the buffer drains.
- **When:** the buffered message is interpreted.
- **Then:**
  - **ledger:** unchanged — the older message never becomes a candidate for
    the newer obligation.
  - **history:** append the user message only.
  - **turn:** one — a normal message turn; `A1` stays open.

#### owner.approval.compound.settle-then-run

- **Example:** One send: Dana clicks Allow and types "then check the logs". The
  command runs first; the log request is its own turn after.
- **Given:** `Batch B { A1: open }` — `A1` the last open member; `W(B)`
  withheld.
- **When:** `Compound(actor, [{ A1, allow }], message)`; each part is
  processed exactly once.
- **Then:**
  - **ledger:** `A1 → settled(allowed)`; continuation claimed.
  - **history, in this order:** `W(B)`, member outcome parts, the allowed
    tool's real result, resumed assistant output — then the user message.
  - **turn:** two — the closure resume, then the message turn.
- **Observed:** serialized: `input.responded`, restored group output, group
  `action.result` events, resumed assistant output, then `message.received`.

#### owner.approval.compound.settle-then-run-siblings-open

- **Example:** Same send, but a second approval from the same turn is still
  open — the message runs while the batch keeps waiting.
- Same delivery, but `B` has other open members.
- **Then:**
  - **ledger:** `A1` settles; `B` stays pending; no continuation claim.
  - **history:** the user message only — `W(B)` stays out, no outcome parts
    yet.
  - **turn:** one — the message turn; no group tool runs yet.
- **Observed:** `input.responded` precedes `message.received`; the group's
  `action.result` is absent.

#### owner.approval.compound.reject-stale-then-run

- **Example:** Dana clicks Allow on yesterday's settled card and adds "did this
  go out?". The agent answers; nothing reruns.
- **Given:** `A1` terminal.
- **When:** one delivery contains a response for `A1` plus a message.
- **Then:**
  - **ledger:** unchanged; the candidate is recorded stale.
  - **history:** the synthetic stale-context message, then the user message.
  - **turn:** one — a message turn carrying both; no stale tool runs.
- **Observed:** `input.response.rejected(reason: stale)` precedes
  `message.received`.

### owner.question

#### owner.question.response.settle-answer

- **Example:** Agent asked "Deploy to which environment?" via `ask_question`.
  Dana picks `staging`; the agent continues with staging.
- **Given:** `Batch B { Q1: open }`; `W(B)` — the assistant output containing
  the `ask_question` call — withheld.
- **When:** a correlated answer accepted by the question's response policy.
- **Then:**
  - **ledger:** `Q1 → settled(answered)`; closes only that question; the
    group closes when its last member is terminal.
  - **history:** at closure, `W(B)` plus the answer as `Q1`'s tool-result
    part — the real answer, never a paraphrase.
  - **turn:** one at closure — resume with the answer.
- **Observed:** `input.responded(outcome: answered)` closes only that
  question.

#### owner.question.response.reject-stale

- **Example:** Sam answers `production` after Dana already picked `staging`.
  The agent explains the question was already answered.
- **Given:** `Q1` terminal; the owner session is active.
- **When:** an actor sends a response referencing its request ID.
- **Then:**
  - **ledger:** unchanged; the candidate is recorded stale.
  - **history:** one synthetic stale-context message; no question result is
    replayed.
  - **turn:** one — a context turn.
- **Observed:** `input.response.rejected(reason: stale)`, then model output,
  then `session.waiting`; no question result is replayed.

#### owner.question.message.dismiss-superseded

- **Example:** Agent asked "Deploy to which environment?"; Dana instead types
  "actually, cancel the deploy". The question is dismissed and the new
  instruction runs.
- **Given:** `Batch B { Q1: open }`, `W(B)` withheld; `Q1`'s tool declares
  that the originating actor may supersede it with a follow-up.
- **When:** `Message(originating actor, text)`.
- **Then:**
  - **ledger:** `Q1 → dismissed(superseded)`; the group closes ordinarily
    (its owner remains runnable).
  - **history:** `W(B)` restored with a superseded outcome part for `Q1` —
    no fabricated answer — then the user message.
  - **turn:** one — the message turn on the restored transcript. If the
    message was in fact the answer typed as text, the agent handles it
    semantically — the runtime does not guess.
- **Observed:** `input.dismissed` precedes `message.received`.

#### owner.question.message.run-open-other-actor

- **Example:** Sam chats while Dana's question is open. The question keeps
  waiting for Dana.
- **Given:** `Q1` open.
- **When:** a non-originating actor sends a message.
- **Then:**
  - **ledger:** unchanged — `Q1` remains open.
  - **history:** the user message; `W(B)` stays out.
  - **turn:** one — a normal message turn.
- **Observed:** `message.received` and no closure event for the question.

#### owner.question.compound.settle-then-run

- **Example:** One send: Dana picks `staging` and types "and bump the version".
- **Given:** `Q1` open.
- **When:** one delivery contains an accepted answer plus a message.
- **Then:**
  - **ledger:** the answer settles `Q1`; supersession does not run.
  - **history:** the closure content of `settle-answer` (when the group
    closes), then the user message.
  - **turn:** the closure resume when the group closes, then the message
    turn.
- **Observed:** `input.responded` precedes `message.received`.

### owner.batch

#### owner.batch.response.settle-partial

- **Example:** One turn asked approval for both `bash npm publish` and
  `send_email`. Dana approves the email only; nothing runs yet and publish
  still waits.
- **Given:** `Batch B { A1: open, A2: open }` — multiple open members from
  one assistant turn; `W(B)` withheld.
- **When:** an accepted response settles `A1` while `A2` remains open.
- **Then:**
  - **ledger:** `A1` settles; `A2` stays open; `B` stays pending; the
    continuation is untouched.
  - **history:** **unchanged** — `W(B)` appears zero times; no outcome part
    for `A1` yet; no synthetic messages.
  - **turn:** **none** — the delivery is fully absorbed by the ledger and the
    settlement event (invariant 2). No group tool runs.
- **Observed:** the group remains pending and the withheld output appears zero
  times in committed history.

#### owner.batch.close.fire-continuation

- **Example:** Dana then approves `bash npm publish` too. The withheld output
  appears and both approved tools run.
- **Given:** `Batch B` with exactly one member still open; every sibling
  terminal; `W(B)` withheld.
- **When:** that member settles, or is superseded while its owner remains
  runnable.
- **Then:**
  - **ledger:** last member terminal; continuation `pending → claimed`.
  - **history:** `W(B)` exactly once, every member's outcome part, and each
    allowed tool's real result.
  - **turn:** one — resume with all results.
- **Observed:** each tool call, response, and tool result appears exactly
  once.

#### owner.batch.message.dismiss-question-only

- **Example:** One turn raised a `bash` approval and a question. Dana's follow-
  up message dismisses only the question; the approval keeps waiting.
- **Given:** `Batch B { A1: open, Q1: open }` — a mixed group; `W(B)`
  withheld.
- **When:** the originating actor supersedes `Q1` with a message.
- **Then:**
  - **ledger:** only `Q1 → dismissed(superseded)`; `A1` stays open; `B` stays
    pending.
  - **history:** the user message; `W(B)` stays withheld until `A1` also
    closes.
  - **turn:** one — the message turn.
- **Observed:** `input.dismissed` names the question only; the approval
  remains open in the same group.

#### owner.batch.park.append

- **Example:** Monday's `bash` approval is still open when Tuesday's turn
  raises a `send_email` approval. Both cards work independently.
- **Given:** `Batch B1` still has open members.
- **When:** a later turn's outcome parks with its own requests (a
  turn-outcome input, not a delivery).
- **Then:**
  - **ledger:** append `Batch B2` with its own withheld output `W(B2)`; both
    groups independently addressable; closing one never changes or replays
    the other.
  - **history:** nothing — both outputs stay withheld.
  - **turn:** the parking turn ends; none runs until responses arrive.
- **Observed:** `input.requested` exposes every new request ID exactly once.

#### owner.batch.park.dedupe-open-intent

- **Example:** The `bash npm publish` approval is open; Dana chats; the model
  retries `bash npm publish` inside that chat turn. No second card appears —
  the retry is told the approval is already pending.
- **Given:** `Batch B1 { A1: open }` where `A1` carries approval intent `K` —
  the tool's `approvalKey(toolInput)`, defaulting to the tool name — and a
  later model turn is running (for example via
  `owner.approval.message.run-open`).
- **When:** that turn's outcome raises an approval whose intent is also `K`
  (invariant 4).
- **Then:**
  - **ledger:** no second open approval for `K` is appended — `A1` remains
    the single addressable obligation for the intent; one settlement
    adjudicates the intent once.
  - **history:** the duplicate tool call closes with a synthetic
    already-pending result part naming `A1`'s request ID; no new withheld
    output is held for it.
  - **turn:** the raising turn continues with that result — as with a denied
    tool, the model reacts instead of parking.
- **Observed:** no second `input.requested` for intent `K`; `A1`'s later
  settlement runs the tool at most once.

#### owner.batch.park.persist-with-runtime-action

- **Example:** One turn raises a `bash` approval and starts a research
  subagent. The card is exposed before the subagent work proceeds.
- **Given:** one assistant turn creates HITL requests and starts a subagent or
  remote action.
- **When:** the turn's outcome parks.
- **Then:**
  - **ledger:** both the group and the runtime action persist; every request
    is exposed before dispatching or waiting. No approval disappears behind
    the runtime action.
  - **history:** nothing until closure.
  - **turn:** the parking turn ends.
- **Observed:** `input.requested` appears exactly once for every request.

#### owner.batch.park.fail-closed-metadata

- **Example:** eve cannot reconstruct the tool call behind an approval
  (corrupted state). The turn fails loudly instead of running it or silently
  waiting.
- **Given:** a nonautomatic approval exists but eve cannot recover the
  matching tool-call metadata needed for `InputRequest`.
- **When:** the turn's outcome would park.
- **Then:**
  - **ledger:** no hidden approval is appended; the turn fails explicitly.
  - **history:** nothing — no tool executes, no sibling action dispatches,
    no synthetic result is fabricated.
  - **turn:** none — the turn fails instead of waiting.
- **Observed:** `step.failed(code: HITL_REQUEST_METADATA_MISSING)` precedes
  `turn.failed` and `session.failed`; `session.waiting` is absent.

#### owner.batch.forced-close.no-continuation

- **Example:** Dana cancels the turn while two approvals wait. Both are
  dismissed and nothing ever runs.
- **Given:** `Batch B` has open members; `W(B)` withheld.
- **When:** cancellation or session termination dismisses them.
- **Then:**
  - **ledger:** members dismissed; continuation `pending → suppressed`, never
    claimed.
  - **history:** unchanged — `W(B)` is never restored; no outcome parts.
  - **turn:** none — no group tool, no model call.
- **Observed:** `input.dismissed` events precede the cancellation or terminal
  session event.

### owner.limit

#### owner.limit.message.supersede

- **Example:** The token-limit prompt is up; Dana types "keep going please"
  instead of clicking Continue. A fresh prompt replaces it; no tokens are
  spent.
- **Given:** `Limit(gen) { open }`; the limit still applies.
- **When:** `Message(any actor, text)` without a Continue.
- **Then:**
  - **ledger:** `Limit(gen) → dismissed(superseded)`; `Limit(gen+1)` opens
    with a new request ID from the monotonic generation.
  - **history:** unchanged — the message is consumed by the limit check: its
    text never enters history and is not replayed later. The prompt exists
    to stop spend.
  - **turn:** none.
- **Observed:** `input.dismissed(old)` precedes `input.requested(new)`; the
  message is not hidden in deferred input.

#### owner.limit.response.settle-continue

- **Example:** Dana clicks Continue. The paused turn resumes under a fresh
  budget.
- **Given:** `Limit(gen) { open }`; a turn is parked at the budget gate.
- **When:** the actor sends the correlated Continue response.
- **Then:**
  - **ledger:** `Limit(gen) → settled(continued)`; continuation claimed; a
    fresh budget window opens.
  - **history:** any co-delivered message appends; the prompt itself leaves
    no transcript content.
  - **turn:** one — the gated turn resumes under the new budget and
    processes any co-delivered message.
- **Observed:** `input.responded` precedes `message.received` when a message
  is present.

#### owner.limit.response.settle-stop

- **Example:** Dana clicks Stop. The turn is cancelled; the session stays
  usable.
- **Given:** `Limit(gen) { open }`; a turn is parked at the budget gate.
- **When:** the actor sends the correlated Stop response.
- **Then:**
  - **ledger:** `Limit(gen) → settled(stopped)`; continuation claimed.
  - **history:** unchanged.
  - **turn:** none — the active turn is cancelled; the session remains
    resumable afterward.
- **Observed:** `input.responded` precedes `turn.cancelled`; the session
  remains resumable afterward.

#### owner.limit.response.reject-stale

- **Example:** Dana clicks Continue on the superseded prompt in a stale tab.
  Nothing resumes; the fresh prompt still waits.
- **Given:** `Limit(gen)` superseded; `Limit(gen+1) { open }`.
- **When:** a Continue or Stop response references `gen`.
- **Then:**
  - **ledger:** unchanged — no budget change, no cancellation; the candidate
    is recorded stale.
  - **history:** unchanged — a stale limit answer is dropped outright, never
    converted into a synthetic context message; it must not reach the model.
  - **turn:** none.
- **Observed:** `input.response.rejected(reason: stale)` references the old
  prompt; the fresh prompt remains open.

### owner.auth

#### owner.auth.message.run-open

- **Example:** The ACME sign-in link is pending; Dana asks "what is this for?".
  The agent answers; the sign-in keeps waiting.
- **Given:** `AuthGroup G { C1: open }` with an `authorizationId` bound to
  its actor and blocked operation.
- **When:** `Message(any actor, text)`.
- **Then:**
  - **ledger:** unchanged — `C1` remains open.
  - **history:** the user message only.
  - **turn:** one — a normal message turn.
- **Observed:** `message.received` and no `authorization.completed`.

#### owner.auth.callback.complete

- **Example:** Agent needs ACME credentials for a lookup. Dana finishes ACME's
  OAuth; the blocked lookup re-drives with the token.
- **Given:** `AuthGroup G { C1: open }`.
- **When:** `Callback` carrying `C1`'s `authorizationId` resolves.
- **Then:**
  - **ledger:** `C1 → completed(actual outcome)`; when `C1` is the last open
    member, continuation `pending → claimed`.
  - **history:** nothing synthetic on `authorized` — the re-driven turn
    appends its own output; `declined`/`failed` surface as the blocked
    action's corresponding error `action.result` part.
  - **turn:** one at group closure — the blocked turn re-drives with every
    callback result available; `authorized` resumes the blocked operation,
    `declined`/`failed` let the model continue with the error result;
    `cancelled` follows the cancellation boundary instead.
- **Observed:** callback receipt alone is not completion. Required, callback,
  and completed events share one `authorizationId`.

#### owner.auth.callback.reject-stale

- **Example:** Dana clicks the old sign-in link again after already
  authorizing. The second callback is rejected.
- **Given:** `C1` already completed — by callback, deadline, or closure — or
  no matching challenge is open.
- **When:** a callback arrives.
- **Then:**
  - **ledger:** unchanged; nothing resumes.
  - **history:** unchanged.
  - **turn:** none.
- **Observed:** `authorization.callback.rejected(reason: stale)` with the
  challenge's `authorizationId` when one existed. A callback with no matching
  challenge is rejected the same way, never silently queued.

#### owner.auth.deadline.complete-timed-out

- **Example:** Agent wants to authenticate with ACME's OAuth. Dana never
  finishes signing in before the deadline; the lookup fails as timed-out and
  the agent says so.
- **Given:** `C1` open with a deadline.
- **When:** `Deadline(C1)` fires before its callback — a first-class timer
  input.
- **Then:**
  - **ledger:** `C1 → completed(timed-out)`; group closure per members.
  - **history:** the blocked action's timed-out error `action.result` part at
    group closure.
  - **turn:** the closure re-drive proceeds with the failure; the blocked
    operation is never performed as authorized.
- **Observed:** exactly one `authorization.completed(outcome: timed-out)`.

#### owner.auth.close.complete

- **Example:** The session ends while the ACME sign-in is pending. The
  challenge completes as cancelled.
- **Given:** `C1` open.
- **When:** the owning turn is cancelled or the session ends.
- **Then:**
  - **ledger:** turn cancellation, session completion, and explicit
    termination map to `completed(cancelled)`; session failure maps to
    `completed(failed)`; the continuation is suppressed.
  - **history:** unchanged — no re-drive.
  - **turn:** none.
- **Observed:** exactly one `authorization.completed` with that outcome.

### owner cancellation

#### owner.obligation.turn-cancel.dismiss

- **Example:** Dana cancels Tuesday's turn. Only Tuesday's approval is
  dismissed; Monday's keeps waiting.
- **Given:** open obligations owned by multiple turns.
- **When:** `CancelTurn` for one owning turn.
- **Then:**
  - **ledger:** only obligations bound to the cancelled turn are
    `dismissed(cancelled)`; their groups' continuations are suppressed;
    obligations of other turns remain open.
  - **history:** unchanged — forced closure restores nothing.
  - **turn:** none.
- **Observed:** every `input.dismissed(reason: cancelled)` precedes
  `turn.cancelled`.

#### owner.obligation.session-end.dismiss

- **Example:** The session times out with an approval and a question open. Both
  are dismissed as session-ended.
- **Given:** open owned obligations.
- **When:** the session completes, fails, times out, or is terminated.
- **Then:**
  - **ledger:** every open owned obligation is `dismissed(session-ended)`;
    continuations are suppressed.
  - **history:** unchanged.
  - **turn:** none.
- **Observed:** every `input.dismissed(reason: session-ended)` precedes the
  terminal session event.

### scheduler

Scheduler rows govern admission only; what each admitted delivery does to the
ledger, history, and turn is its own catalog row.

#### scheduler.delivery.admit-arrival-order

- **Example:** Mid-turn, Dana clicks Allow and then sends "also update the
  docs". At the boundary the Allow is interpreted first, the message second.
- **Given:** `TurnActive`; deliveries `D1..Dn` buffered in durable arrival
  order.
- **When:** the turn reaches a receptive boundary.
- **Then:**
  - **ledger:** each `Di` is interpreted exactly once, against the state
    produced by `D(i-1)`.
  - **history / turn:** whatever each `Di`'s own row dictates — admission
    itself adds nothing.
- **Observed:** their `message.received` and resulting transition events retain
  arrival order.

#### scheduler.delivery.admit-actor-partition

- **Example:** Mid-turn messages arrive from Dana, then Sam, then Dana again.
  They drain as three inputs, never merged into one.
- **Given:** buffered deliveries from actor A, then B, then A.
- **When:** eve drains them.
- **Then:**
  - **ledger:** three ordered actor-homogeneous turn inputs; no merging
    across actor boundaries.
  - **history / turn:** per partition, per each delivery's own row.
- **Observed:** each `message.received` is evaluated with its own verified
  actor and durable arrival order.

### projector

Routes live in the parent's ledger; projection is events-only traffic. In
every projector row the parent's **history is unchanged** and the parent runs
**no model turn** — forwarding is transport, and the child owns the
obligation.

#### projector.route.park.project

- **Example:** A child research subagent raises a `bash` approval. The parent
  session shows Dana the same card; the child stays the owner.
- **Given:** no route for the request.
- **When:** a child session creates a HITL request and the parent receives it
  (a child event, not a delivery).
- **Then:**
  - **ledger:** `Route(requestId): absent → active`; the child remains the
    owner; the parent exposes an actionable copy.
  - **history / turn:** parent unchanged; none.
- **Observed:** the parent stream re-emits `input.requested` with the same
  request ID.

#### projector.route.close.project

- **Example:** The approval settles inside the child. The parent re-announces
  the closure and drops its copy of the card.
- **Given:** `Route(requestId): active`.
- **When:** the child settles or dismisses the projected request.
- **Then:**
  - **ledger:** only that request's route drops; sibling routes remain
    active.
  - **history / turn:** parent unchanged; none.
- **Observed:** the parent re-emits the closure with `scope: projection`.

#### projector.route.drop.route-lost

- **Example:** The parent session ends while the child's card is still showing.
  The parent dismisses its copy as route-lost; the child's request is
  untouched.
- **Given:** active routes.
- **When:** the parent's route to a child request becomes unusable, or the
  parent session ends with active routes.
- **Then:**
  - **ledger:** the parent dismisses only its projected copies as route-lost;
    it never claims the child requests settled.
  - **history / turn:** parent unchanged; none.
- **Observed:** `input.dismissed(scope: projection, reason: route-lost)`
  precedes route removal or the parent terminal event.

#### projector.route.response.reject-stale-after-drop

- **Example:** Dana clicks Allow on the child's card, but the child already
  finished and its hook is gone. Nothing resumes and the parent does not fail.
- **Given:** a route still exists but the child's continuation hook has been
  disposed.
- **When:** a response reaches that route before cleanup.
- **Then:**
  - **ledger:** the route closes as route-lost; no other obligation mutates.
  - **history / turn:** parent unchanged; none — eve does not resume the
    child, fail the parent, or call the model.
- **Observed:** `input.dismissed(scope: projection, reason: route-lost)`, then
  `input.response.rejected(scope: projection, reason: stale)`;
  `session.failed` is absent.

#### projector.route.response.forward-responder

- **Example:** Sam approves the child-owned card in the parent channel. The
  child sees Sam as the responder, not the parent session.
- **Given:** `Route(requestId): active`.
- **When:** an actor responds through the parent channel to the child-owned
  request.
- **Then:**
  - **ledger:** the parent forwards the verified responder unchanged; the
    child evaluates its own response policy and takes its own transitions.
    If the child emits `input.response.pending`, the parent projects that
    event and the matching authorization events with unchanged `candidateId`
    and `authorizationId`; the callback route remains child-owned.
  - **history / turn:** parent unchanged; none.
- **Observed:** the child outcome is re-emitted by the parent without
  substituting the parent actor.

#### projector.route.response.reject-unauthorized-remote

- **Example:** A remote child rejects Sam's forwarded identity proof. The
  request stays open and no remote tool runs.
- **Given:** `Route(requestId): active` to a remote child.
- **When:** the remote child rejects the forwarded principal or responder
  proof.
- **Then:**
  - **ledger:** fail closed — the request stays open; no remote tool runs.
  - **history / turn:** parent unchanged; none.
- **Observed:** the parent re-emits
  `input.response.rejected(scope: projection, reason: unauthorized)`; no
  terminal request event.

## Implementation state and staging

Shipped by the mitigations, with their deliberate deviations from this
contract:

- **Always-receptive scheduler** — [#1830] (authorization; via a window-gated
  extra inbox source, superseded by the transport consolidation above) and
  [#1868] (approvals). The two blocked continuations are gone.
- **Group collection** — [#1868] stores pending batches as an ordered list
  with a legacy-key read shim. Deviations to replace: partial responses are
  deferred rather than settled per-member
  (`owner.batch.response.settle-partial`); text matching is retained
  (`owner.approval.message.run-open`); question supersession is not
  actor-scoped (`owner.question.message.run-open-other-actor`); multi-batch
  question dismissal is suppressed rather than per-group.

### Consolidation: one interpreter

The machine above is currently implemented nowhere and enforced everywhere:
interpretation logic is smeared across ten modules, each owning a fragment of
the transition table. That dispersion is why both wedges could exist — no
single seam ever saw the whole state.

| Fragment                                         | Today lives in                                                                                                                                                                                           |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| batch resolution, defer decisions                | [`harness/input-requests.ts`](../packages/eve/src/harness/input-requests.ts)                                                                                                                             |
| batch + deferred-input storage                   | [`harness/pending-input-batches.ts`](../packages/eve/src/harness/pending-input-batches.ts)                                                                                                               |
| stale-response conversion (a second interpreter) | [`harness/stale-input-responses.ts`](../packages/eve/src/harness/stale-input-responses.ts)                                                                                                               |
| required/dismissable classification              | [`harness/input-request-class.ts`](../packages/eve/src/harness/input-request-class.ts)                                                                                                                   |
| limit prompt creation + resolution special cases | [`harness/session-limit-enforcement.ts`](../packages/eve/src/harness/session-limit-enforcement.ts), [`harness/session-limit-continuation.ts`](../packages/eve/src/harness/session-limit-continuation.ts) |
| challenge storage + callback pairing             | [`harness/authorization.ts`](../packages/eve/src/harness/authorization.ts), [`execution/workflow-steps.ts`](../packages/eve/src/execution/workflow-steps.ts)                                             |
| callback wait scheduling                         | [`execution/workflow-entry.ts`](../packages/eve/src/execution/workflow-entry.ts), window gating in [`execution/session-command-inbox.ts`](../packages/eve/src/execution/session-command-inbox.ts)        |
| projection routing                               | [`harness/proxy-input-requests.ts`](../packages/eve/src/harness/proxy-input-requests.ts), [`execution/subagent-hitl-proxy.ts`](../packages/eve/src/execution/subagent-hitl-proxy.ts)                     |
| text matching in the resolution path             | [`channel/resolve-text.ts`](../packages/eve/src/channel/resolve-text.ts) via input-requests                                                                                                              |
| forced-closure sweeps                            | [`execution/settle-cancelled-turn-step.ts`](../packages/eve/src/execution/settle-cancelled-turn-step.ts)                                                                                                 |

Target shape — one harness-owned package implements the machine; everything
else is an adapter that feeds it inputs or executes its plans:

```text
harness/hitl/
  types.ts         state, inputs, transitions, and ordered effects
  obligations.ts   one durable ledger: obligations, groups, candidates,
                   routes, and generations; migration + the only state writer
  interpret.ts     pure (HitlState, HitlInput) ->
                   HitlDecision { nextState, effects }
  projector.ts     routes: project / forward / re-emit / drop
  events.ts        domain transition -> protocol event
  execute.ts       persist nextState, then perform effects in order
```

Adapters after consolidation:

- **tool-loop**: parked model output becomes an ApprovalBatch continuation;
  new requests and challenges return as turn outcomes. `execute.ts` owns the
  ordered effects. This replaces `resolvePendingInput`, the stale-conversion
  pass, the limit special cases, and deferral _decisions_. The AI SDK constraint
  that an approval response resolves in isolation becomes an ordered effect
  sequence, not a hidden state key.
- **workflow-steps**: callback extraction and `authorization.completed`
  emission become `interpret(Callback)`; `derivePendingState` reads the one
  store.
- **workflow-entry**: pure scheduler. The window machinery
  (`claimAuthorization`, `setAuthorizationWindow`, `nextWithSource`,
  `awaitAuthorizationResume`) is deleted by the transport consolidation;
  callbacks arrive through the one command stream and are classified by
  payload, which the turn step already does.
- **session-limit-enforcement**: the budget gate opens a `Limit(gen)`
  obligation in the store; resolution is an interpret row like any other.
- **proxy modules**: fold into `projector.ts`.
- **resolve-text**: leaves the runtime path; stays exported for channel
  adapters.

Deleted outright: `stale-input-responses.ts` (becomes the `reject-stale`
rows), `input-request-class.ts` (classification is the obligation kind), the
inbox window machinery, and `deferredStepInput` as a decision mechanism. If
internal-step persistence remains necessary, it stores an executor-owned effect
cursor, never reinterpretable user input.

### Stages

Each lands alone with its own gate; after stage 4, every remaining contract
behavior is a diff to `interpret.ts` and its unit matrix.

1. **Store extraction.** `obligations.ts` unifies pending batches,
   `pendingAuthorization`, and the limit prompt into one shape, with
   candidate records and generations. Pure data; existing suite unchanged;
   read shims for both legacy keys.
2. **Interpreter extraction.** `interpret.ts` absorbs `resolvePendingInput`,
   stale conversion, and limit resolution, behavior-preserving; the existing
   unit matrices move with it. Text matching enters as an explicit,
   removable rule.
3. **Auth through the machine.** Challenge parks become AuthGroups in the
   store; callback extraction becomes `interpret(Callback)`; the deadline
   becomes a timer input (today it has no producer). Multi-challenge resume
   falls out of group closure.
4. **Transport and routing.** Callbacks through the command stream (window
   machinery deleted; in-flight challenge-URL cost per Compatibility);
   projector extraction with per-request route accumulation (fixes #1608);
   actor-partitioned coalescing.
5. **Behavior completion, inside the interpreter.** Per-member settlement
   replacing defer-partials; actor-scoped question supersession; text-match
   removal with its docs update; fail-closed request creation (fixes #1201);
   limit re-prompt closure.
6. **Lifecycle events + eval matrix.** `events.ts` emits the event family;
   the gated evals
   ([`e2e/fixtures/agent-tools-hitl/evals/lifecycle/`](../e2e/fixtures/agent-tools-hitl/evals/lifecycle/coverage.md))
   activate via `EVE_HITL_LIFECYCLE_CONTRACT=1`, keyed by anchor, with
   expected sequences written literally and never computed from runtime
   code.

The acceptance gate for the late splice —
[`tool-loop-generate-approval-resume.integration.test.ts`](../packages/eve/src/harness/tool-loop-generate-approval-resume.integration.test.ts)
with a normal turn between the approval request and its response — shipped
with [#1868] and passes; provider converters remain the residual risk to
verify against real models.

## Closed when this ships

Fixes [#1224](https://github.com/vercel/eve/issues/1224) — freeform reply to a
pending approval mutes the session forever (behavioral core shipped in
[#1868]).
Fixes [#1201](https://github.com/vercel/eve/issues/1201) — approval silently
dropped when a step also requests a subagent call.
Fixes [#1608](https://github.com/vercel/eve/issues/1608) — duplicate input
response resumes a disposed child hook and fails the parent.

## Related, not closed by this

- [#786](https://github.com/vercel/eve/issues/786) — consumed-as-answer half
  is fixed; mid-turn steering is out of scope.
- [#1095](https://github.com/vercel/eve/issues/1095) — settlement events are
  PR #1368.
- [#1021](https://github.com/vercel/eve/issues/1021) — responder
  authorization, owned by PR #1368.
- [#1658](https://github.com/vercel/eve/issues/1658) — OpenAI provider
  transcript-shape bug; not fixed here.

## Related work

- [`hitl-engine.md`](./hitl-engine.md): implementation
  architecture for one durable store, pure interpreter, and ordered effect
  executor.
- [PR #1368](https://github.com/vercel/eve/pull/1368): responder identity,
  authorization, Allow, Cancel, and request settlement.
- [PR #1231](https://github.com/vercel/eve/pull/1231): makes every message
  replace unresolved input. Replacing another actor's request breaks
  ownership.
- [PR #142](https://github.com/vercel/eve/pull/142): Slack-specific responder
  enforcement.

[#1830]: https://github.com/vercel/eve/pull/1830
[#1868]: https://github.com/vercel/eve/pull/1868
