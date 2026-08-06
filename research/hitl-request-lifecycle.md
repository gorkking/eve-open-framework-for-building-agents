---
issue: https://github.com/vercel/eve/issues/1224
status: proposed
last_updated: "2026-08-06"
---

# HITL requests must not wedge sessions

## The problem

Today, a user can send a message while an approval is waiting and get no useful
response.

```text
approval waits
  -> user sends unrelated message
  -> eve hides the message in deferredStepInput
  -> eve waits for the approval again
```

No model call runs. If nobody answers the approval, the message stays hidden.
The session looks broken.

This proposal sets three rules:

1. **Pending requests never block the conversation.** An unrelated message runs
   as a normal turn. The request just stays unanswered.
2. **Do not steal someone else's request.** An unrelated message cannot approve,
   deny, cancel, dismiss, or replace an existing HITL request.
3. **Show request closure.** Emit `input.requested` before waiting, then emit a
   settlement event or `input.dismissed` when the request stops being usable.

## Who owns what

- The **owner session** stores and settles the request. A child agent owns its
  own request even when a parent shows that request to the channel.
- The **originating actor** is the user whose turn created the request.
- The **current actor** is the user sending the new message or response.

These are different identities. Session admission does not grant permission to
change a HITL request.

## Normative use cases

These scenarios define the behavior. Implementation and tests use the scenario
IDs.

Terms used below:

- **Open:** the request can still be answered.
- **Settled:** an accepted response closed the request.
- **Dismissed:** the request closed without an accepted response.
- **Unrelated message:** a message not accepted as a response to the request.
- **Correlated response:** a response naming one open `requestId`, or plain text
  that matches exactly one open request under that request's text policy.
- **Accepted response:** a correlated response accepted by the gate for that
  decision. Allow uses the tool's response authorizer. Cancel requires an
  authenticated actor and bypasses the Allow authorizer. Question answers and
  session-limit Continue/Stop use their owning tool or runtime gate.
- **Adjudication:** the response policy's decision on a correlated approval
  response: accept or reject. An accepted response settles the request with the
  outcome its value carries (`allowed` or `denied`). A rejected response never
  settles the request: the request stays open for an authorized responder, and
  the rejection becomes turn context so the agent can react. Policy throw or
  timeout is not an adjudication.
- **Normal turn:** a turn that emits `message.received` and may call the model.

`Observed` lists the required events and their relative order. Ordinary turn
events may appear between them unless the scenario says the sequence is exact.

Request lifecycle events have fixed names:

- `input.responded`: an accepted response settled the request;
- `input.response.rejected`: a response was invalid, stale, or unauthorized and
  did not close the request;
- `input.response.pending`: a correlated response is waiting on separate
  authorization and did not close the request;
- `input.dismissed`: the request closed without an accepted response.

`input.dismissed.reason` is one of:

- `superseded`: an owner-declared follow-up or newer prompt replaced it;
- `cancelled`: its owning turn was cancelled;
- `session-ended`: its owner session ended while it was open;
- `route-lost`: an ancestor can no longer route to the child-owned request.

`input.response.rejected.reason` is one of `invalid`, `stale`, `unauthorized`,
`policy-failed`, or `candidate-cancelled`.

All four events identify one request:

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

Owner events use the request's originating turn coordinates. Projection events
keep those coordinates and change only `scope`.

Eve derives `candidateId` from `{ requestId, deliveryId }`; ingress supplies the
durable `deliveryId`, not a candidate ID. Retrying the same delivery reuses the
candidate. A new delivery creates a new candidate and participates in the
request's atomic single-winner transition.

Every request has at most one `input.responded`. Competing or duplicate
responses after the winner emit `input.response.rejected(reason: stale)`, for
all request kinds.

The owner commits one atomic transition from open to either `input.responded`
or `input.dismissed`. Response, supersession, cancellation, re-prompt, and
session-end races all use that transition. After one wins, later responses are
stale and later dismissals are no-ops. Tool dispatch rechecks turn and session
cancellation after winning and before execution.

Every admitted delivery initiates a turn. When a settlement closes a batch,
the turn continues from the restored model output and tool results. When a
delivery's responses are rejected, stale, invalid, or pending, the turn input
is that event context — who attempted what, and why it did not settle — so the
agent can respond in-channel. The request state is unchanged by such a turn.
Retries of the same delivery are deduplicated at admission and do not start
additional turns.

Authorization lifecycle events carry one `authorizationId`, the verified actor
or null, and the blocked operation identity. `authorization.required`, its
callback, and `authorization.completed` use that ID.
`authorization.callback.rejected(reason: stale)` reports callbacks received
after closure.

### Approval requests

#### AP-1: Originating actor approves

- **Given:** A's approval request is open.
- **When:** A sends an explicitly correlated Allow response that the tool's
  response policy accepts.
- **Then:** The request settles as allowed and the tool becomes eligible. The
  tool runs only when this response closes its assistant-turn input batch.
- **Observed:** `input.responded` precedes `action.result`.

#### AP-2: Another actor approves

- **Given:** A's approval request is open.
- **When:** B sends an explicitly correlated Allow response that the tool's
  response policy accepts.
- **Then:** The request settles as allowed and the tool becomes eligible. The
  tool runs only when this response closes its assistant-turn input batch.
- **Observed:** The result is identical to AP-1 except the verified responder
  is B.

#### AP-3: Response policy rejects the responder

- **Given:** A's approval request is open.
- **When:** B sends a correlated response and the response policy rejects B.
- **Then:** The request remains open and the tool does not run. The agent
  initiates a turn with the rejection as context, so it can respond in-channel
  — for example, telling B who may approve. The request stays answerable by an
  authorized responder.
- **Observed:** `input.response.rejected(reason: unauthorized)` with responder
  B, then a normal turn's model output, then `session.waiting`. No settlement
  or dismissal event appears for the request.

#### AP-4: Originating actor sends an unrelated message

- **Given:** A's approval request is open.
- **When:** A sends an unrelated message.
- **Then:** The approval remains open. The message runs as a normal turn.
- **Observed:** Eve emits `message.received`; it emits no settlement or
  `input.dismissed` event for the approval.

#### AP-5: Another actor sends an unrelated message

- **Given:** A's approval request is open.
- **When:** B sends an unrelated message.
- **Then:** The approval remains open and owned by its original session. B's
  message runs as a normal turn.
- **Observed:** Eve emits `message.received` for B; it emits no settlement or
  `input.dismissed` event for A's approval.

#### AP-6: Plain text looks like an approval response

- **Given:** A's approval request is open.
- **When:** an actor sends the plain message `approve`.
- **Then:** Eve treats it as an approval response only when exactly one open
  request matches, that request allows text matching, and its response policy
  accepts the actor. Zero or multiple matches settle no request through text
  matching; Eve then applies each request's unrelated-message rule.
- **Observed:** Text matching alone never settles the request.

When zero or multiple requests match, Eve settles none and then applies each
open request's unrelated-message rule. An originating actor may therefore
supersede their question under Q-2 while approvals remain open.

#### AP-7: Response and unrelated message arrive together

- **Given:** A's approval request is the last open request in its assistant-turn
  input batch.
- **When:** one delivery contains an accepted response plus an unrelated
  message.
- **Then:** Eve settles the approval and runs the unrelated message as a normal
  turn. Each part is processed exactly once.
- **Observed:** Processing is serialized: `input.responded`, restored batch
  output, batch `action.result` events, resumed assistant output, then
  `message.received`.

#### AP-7B: Response closes one request but siblings remain open

- **Given:** A's approval belongs to a batch with other open requests.
- **When:** one delivery contains an accepted approval response plus an
  unrelated message.
- **Then:** Eve settles that approval and runs the message. It keeps the batch's
  stored model output pending and runs no batch tool yet.
- **Observed:** `input.responded` precedes `message.received`; `action.result`
  for the batch is absent.

#### AP-8: Approval arrives after intervening turns

- **Given:** A's approval request is the last open request in its assistant-turn
  input batch and one or more unrelated turns completed since it was created.
- **When:** an authorized actor sends an accepted response.
- **Then:** Eve restores the assistant-turn approval batch once, settles the
  request, and runs the approved tool once. Intervening turns remain unchanged.
- **Observed:** The restored assistant output follows the intervening turns in
  history; the request is no longer open.

#### AP-9: Response arrives after closure

- **Given:** an approval request is no longer open but its owner session is
  still active.
- **When:** any actor sends a response referencing its request ID.
- **Then:** Eve changes no request and runs no tool. The agent initiates a turn
  with the stale-attempt context.
- **Observed:** `input.response.rejected(reason: stale)`, then model output,
  then `session.waiting`.

#### AP-10: Stale response and unrelated message arrive together

- **Given:** an approval request is no longer open.
- **When:** one delivery contains a response for that request plus an unrelated
  message.
- **Then:** Eve rejects the stale response and runs the message as a normal
  turn. It changes no request and runs no stale tool call.
- **Observed:** `input.response.rejected(reason: stale)` precedes
  `message.received`.

#### AP-11: Authenticated actor cancels an approval

- **Given:** A's approval request is open.
- **When:** an authenticated actor sends an explicit correlated Cancel.
- **Then:** The request settles as cancelled and the tool does not run.
- **Observed:** `input.responded(outcome: cancelled)` appears once;
  `action.result` contains `{ code: "TOOL_EXECUTION_CANCELLED", approval:
{ requestId, status: "cancelled" }, tool: { result: "not_run" } }`.

#### AP-12: Allow and Cancel race

- **Given:** A's approval request is open.
- **When:** an accepted Allow and an authenticated Cancel race for the same
  request.
- **Then:** Exactly one terminal outcome wins. The loser is stale. The tool runs
  at most once and only when Allow wins.
- **Observed:** Exactly one `input.responded`; the loser emits
  `input.response.rejected(reason: stale)`.

#### AP-13: Two allowed responders race

- **Given:** A's approval request is open and both A and B are allowed to
  respond.
- **When:** A and B race with accepted Allow responses.
- **Then:** Exactly one response settles the request. The tool runs at most once
  and only after its batch closes.
- **Observed:** One `input.responded`, one stale rejection, and at most one tool
  result.

#### AP-14: Duplicate response delivery

- **Given:** one accepted response already settled the approval.
- **When:** Eve receives the same response content as a new delivery.
- **Then:** Eve does not settle or execute again. The agent initiates a turn
  with the stale-attempt context.
- **Observed:** `input.response.rejected(reason: stale)`, then model output,
  then `session.waiting`; no second tool execution.

#### AP-15: Response policy throws or times out

- **Given:** A's approval request is open.
- **When:** a correlated Allow response reaches a response policy that throws
  or times out. This is an infrastructure failure, not an adjudication.
- **Then:** The approval remains open and the tool does not run. The agent
  initiates a turn with the failure context so it can tell the responder to
  retry.
- **Observed:** `input.response.rejected(reason: policy-failed)`, then model
  output, then `session.waiting`. No terminal request event appears.

#### AP-15B: Response value is invalid

- **Given:** A's approval request is open.
- **When:** a correlated response carries an unknown option ID or malformed
  value.
- **Then:** The request remains open and the tool does not run. The agent
  initiates a turn with the invalid-response context.
- **Observed:** `input.response.rejected(reason: invalid)`, then model output,
  then `session.waiting`; no terminal request event.

#### AP-16: Allow candidate requires authorization

- **Given:** A's approval request is open.
- **When:** an Allow candidate requires a separate authorization flow.
- **Then:** Eve keeps a durable pending candidate bound to
  `{ candidateId, requestId, responder }`. The request remains open and the tool
  does not run. The agent initiates a turn with the pending-authorization
  context while the candidate waits.
- **Observed:** `input.response.pending(reason: authorization-required)` opens
  an authorization challenge linked to that candidate.

Duplicate delivery of the same `candidateId` returns the existing pending
candidate and never opens a second authorization challenge.

#### AP-17: Authorization callback arrives after Cancel

- **Given:** an authorization-required Allow candidate is pending.
- **When:** an authenticated Cancel settles the request before the callback,
  then the callback arrives.
- **Then:** Cancel immediately closes the authorization challenge and request.
  The later callback is stale. The tool does not run and the request does not
  reopen.
- **Observed:** `authorization.completed(outcome: cancelled)` precedes the one
  terminal `input.responded(outcome: cancelled)`; the later callback emits
  `authorization.callback.rejected(reason: stale)` for the same
  `authorizationId` and `candidateId`.

### Questions

#### Q-1: Actor answers a question

- **Given:** A's question is open.
- **When:** an actor sends a correlated answer accepted by the question's
  response policy.
- **Then:** The question settles with that answer.
- **Observed:** `input.responded` closes only that question.

#### Q-2: Originating actor moves on

- **Given:** A's question is open and its tool declares that A may supersede it
  with a follow-up.
- **When:** A sends an unrelated message.
- **Then:** The question is dismissed as `superseded`. The message runs as a
  normal turn.
- **Observed:** `input.dismissed` precedes `message.received`.

#### Q-3: Another actor sends an unrelated message

- **Given:** A's question is open.
- **When:** B sends an unrelated message.
- **Then:** A's question remains open. B's message runs as a normal turn.
- **Observed:** Eve emits `message.received` for B and no closure event for the
  question.

#### Q-4: Accepted answer and unrelated message arrive together

- **Given:** A's question is open.
- **When:** one delivery contains an accepted answer plus an unrelated message.
- **Then:** The answer settles the question; supersession does not run. The
  unrelated message runs after any closing assistant-turn batch work.
- **Observed:** `input.responded` precedes `message.received`.

### Assistant-turn input batches

#### B-1: One response leaves sibling requests open

- **Given:** one assistant turn created an input batch containing multiple open
  requests.
- **When:** an accepted response settles one request but siblings remain open.
- **Then:** The answered request is settled. Siblings remain open. Eve does not
  restore the batch's stored model output and does not run any batch tool yet.
- **Observed:** The batch remains pending and the stored model output appears
  zero times in committed history.

#### B-2: Last ordinary outcome closes the batch

- **Given:** one request remains open in an assistant-turn input batch.
- **When:** that request settles, or is superseded while its owner remains
  runnable.
- **Then:** Eve restores the batch's stored model output exactly once, appends
  every request outcome, and runs each allowed tool exactly once. Tools whose
  request settled as denied or cancelled do not run. Rejected candidates do not change a
  request's later eligibility.
- **Observed:** Each tool call, response, and tool result appears exactly once.

#### B-3: Forced closure does not restore the batch

- **Given:** an assistant-turn input batch has open requests.
- **When:** cancellation or session termination dismisses those requests.
- **Then:** Eve does not restore the stored model output and runs no batch tool
  or model call.
- **Observed:** `input.dismissed` events precede the cancellation or terminal
  session event.

#### B-4: Later assistant turns create more batches

- **Given:** an earlier assistant-turn input batch still has open requests.
- **When:** a later turn creates another input batch.
- **Then:** Both batches remain independently addressable. Closing one does not
  change or replay the other.
- **Observed:** `input.requested` exposes every new request ID once.

#### B-5: Mixed approval and question batch

- **Given:** one assistant turn created an approval and a question.
- **When:** the originating actor supersedes the question while the approval
  remains open.
- **Then:** Eve dismisses only the question. It does not restore the stored
  model output or run the approved tool until the approval also closes.
- **Observed:** `input.dismissed` names the question only; the approval remains
  open in the same assistant-turn input batch.

### Timing and identity

#### T-1: Message predates a request

- **Given:** a user message arrived before a request was created.
- **When:** the buffered message is processed after that request exists.
- **Then:** Eve does not interpret the older message as a response to the newer
  request.
- **Observed:** The message runs as a normal turn; the request remains open.

#### T-2: No verified principal

- **Given:** the channel supplies no verified principal.
- **When:** deliveries create and respond to a request in the same session.
- **Then:** Eve treats the session as one actor for origin comparison. The
  request's response policy still controls settlement.

The fallback does not fabricate a verified principal for response policy.

#### T-3: Buffered messages preserve actor boundaries

- **Given:** buffered deliveries arrive from A, then B, then A.
- **When:** Eve drains them.
- **Then:** Eve creates three ordered actor-homogeneous turn inputs. It does not
  merge B's message under A's identity or A's messages under B's identity.
- **Observed:** Each `message.received` is evaluated with its own verified actor
  and durable arrival order.

### Session-limit prompts

#### SL-1: Message arrives while the limit still applies

- **Given:** a session-limit prompt is visible and the limit still applies.
- **When:** any actor sends a message without granting continuation.
- **Then:** Eve dismisses the old prompt as `superseded`, emits a fresh prompt
  with a new request ID generated from a monotonic prompt generation, and does
  not call the model. The triggering message is consumed by the limit check and
  is not replayed later.
- **Observed:** `input.dismissed(old)` precedes `input.requested(new)` and the
  message is not hidden in deferred input.

#### SL-2: Continue response grants another window

- **Given:** a session-limit prompt is open.
- **When:** the actor sends the correlated Continue response.
- **Then:** Eve closes the prompt, grants a fresh budget window, and processes
  any co-delivered message.
- **Observed:** `input.responded` precedes `message.received` when a message is
  present.

#### SL-3: Stop response cancels the turn

- **Given:** a session-limit prompt is open.
- **When:** the actor sends the correlated Stop response.
- **Then:** Eve closes the prompt and cancels the active turn. It does not call
  the model.
- **Observed:** `input.responded` precedes `turn.cancelled`.

#### SL-4: Response targets a superseded prompt

- **Given:** session-limit prompt R1 was superseded by R2.
- **When:** a Continue or Stop response references R1.
- **Then:** Eve changes no budget and does not cancel the turn.
- **Observed:** `input.response.rejected(reason: stale)` references R1; R2
  remains open.

### Connection authorization

#### AU-1: Message arrives while authorization is open

- **Given:** A's connection authorization challenge is open with an
  `authorizationId` bound to A and the blocked operation.
- **When:** A or B sends an unrelated message.
- **Then:** The challenge remains open. The message runs as a normal turn.
- **Observed:** Eve emits `message.received` and no
  `authorization.completed` event.

This is proposed behavior. Today the session driver waits exclusively for the
authorization callback; implementation must let ordinary deliveries start
independent turns while the challenge remains open.

#### AU-2: Authorization callback resolves

- **Given:** an authorization challenge is open.
- **When:** a callback carrying its `authorizationId` resolves.
- **Then:** Eve emits `authorization.completed` with one actual outcome:
  `authorized`, `declined`, `failed`, `timed-out`, or `cancelled`. For a pending
  Allow candidate, `authorized` reruns the current response authorizer; it does
  not settle the request or execute the tool by itself. All other outcomes keep
  the request open and end that candidate without execution.
- **Observed:** Callback receipt alone is not completion. Required, callback,
  and completed events share the same `authorizationId`.

Candidate outcome mapping after `authorization.completed`:

- `authorized`: reevaluate policy, then emit `input.responded`,
  `input.response.pending`, or `input.response.rejected` from that result;
- `declined`: `input.response.rejected(reason: unauthorized)`;
- `failed` or `timed-out`: `input.response.rejected(reason: policy-failed)`;
- `cancelled`: `input.response.rejected(reason: candidate-cancelled)`.

For ordinary connection authorization with no approval candidate:

- `authorized`: resume the blocked operation;
- `declined`: do not execute it; emit an authorization-declined `action.result`,
  then let the model continue;
- `failed` or `timed-out`: do not execute it; emit the corresponding failed
  `action.result`, then let the model continue;
- `cancelled`: do not execute it and follow the cancellation boundary; no model
  continuation is required.

#### AU-3: Authorization ends before callback

- **Given:** an authorization challenge is open.
- **When:** its turn is cancelled or its session ends before the callback.
- **Then:** Turn cancellation, session completion, and explicit termination map
  to `cancelled`; session failure maps to `failed`; authorization deadline maps
  to `timed-out`. Eve does not resume blocked work.
- **Observed:** Eve emits exactly one `authorization.completed` with that
  outcome. A later callback emits
  `authorization.callback.rejected(reason: stale)` with the same
  `authorizationId`.

### Parent and child sessions

#### P-1: Child request is projected to the channel

- **Given:** a child session creates a HITL request.
- **When:** the parent receives that request.
- **Then:** The child remains the request owner. The parent exposes an
  actionable copy to its channel.
- **Observed:** The parent stream re-emits `input.requested` with the same
  request ID.

#### P-2: Parent loses the child route

- **Given:** the parent exposes a child request and its route becomes unusable.
- **When:** the parent removes that route.
- **Then:** The parent dismisses only its projected copy as `route-lost`. It
  does not claim that the child request settled.
- **Observed:** The parent emits `input.dismissed(scope: projection)` before
  removing the route.

#### P-3: Child request closes normally

- **Given:** a child request is projected through a parent.
- **When:** the child settles or dismisses the request.
- **Then:** The parent re-emits the closure with `scope: projection` and removes
  only that request's route.
- **Observed:** Sibling child-request routes remain active.

#### P-4: Response races with child-hook disposal

- **Given:** a parent still has a route for a child request, but the child's
  continuation hook has already been disposed.
- **When:** a response reaches that route before parent cleanup.
- **Then:** Eve does not resume the child, fail the parent, mutate another
  request, or call the model. It closes that route as `route-lost`.
- **Observed:** The parent first emits `input.dismissed(scope: projection,
reason: route-lost)`, then `input.response.rejected(scope: projection,
reason: stale)`; `session.failed` is absent.

#### P-5: Parent forwards responder identity to the child owner

- **Given:** a child-owned request is projected through a parent.
- **When:** an actor responds through the parent channel.
- **Then:** The parent forwards the verified responder unchanged. The child
  evaluates its own response policy and remains the only request owner.
- **Observed:** A rejected or accepted child outcome is re-emitted by the parent
  without substituting the parent actor.

If the child emits `input.response.pending`, the parent projects that event and
the matching `authorization.required`/`authorization.completed` events with
unchanged `candidateId` and `authorizationId`. The callback route remains owned
by the child.

#### P-6: Remote child rejects forwarded identity

- **Given:** a parent projects a request owned by a remote child.
- **When:** the parent forwards a response and the remote child rejects the
  forwarded principal or responder proof.
- **Then:** Eve fails closed. The request remains open and no remote tool runs.
- **Observed:** The parent re-emits
  `input.response.rejected(scope: projection, reason: unauthorized)`; it emits
  no terminal request event.

### Request creation and forced closure

#### L-1: HITL request and runtime action share one assistant turn

- **Given:** one assistant turn creates a question or approval request and
  starts a subagent or remote action.
- **When:** Eve parks or dispatches that turn.
- **Then:** Eve persists both the assistant-turn input batch and the runtime
  action. It exposes every HITL request before dispatching or waiting.
- **Observed:** `input.requested` appears exactly once for every request. No
  approval disappears behind the runtime action.

#### L-2: Approval metadata cannot be recovered

- **Given:** a nonautomatic approval exists but Eve cannot recover the matching
  tool-call metadata needed for `InputRequest`.
- **When:** Eve classifies the assistant turn.
- **Then:** Eve fails the turn explicitly. It does not execute the tool, dispatch
  sibling runtime actions, or wait on a hidden approval.
- **Observed:** `step.failed(code: HITL_REQUEST_METADATA_MISSING)` precedes
  `turn.failed` and `session.failed`; `session.waiting` is absent.

#### L-3: Turn cancellation closes open requests

- **Given:** the owner session has open requests created by multiple turns.
- **When:** the owning turn is cancelled.
- **Then:** Eve dismisses only requests bound to the cancelled turn. Requests
  from earlier or later turns remain open.
- **Observed:** Every `input.dismissed(reason: cancelled)` precedes
  `turn.cancelled`.

#### L-4: Session ends with open requests

- **Given:** the owner session has open requests.
- **When:** the session completes, fails, times out, or is terminated.
- **Then:** Eve dismisses every open owned request as `session-ended`.
- **Observed:** Every `input.dismissed(reason: session-ended)` precedes the
  terminal session event.

#### L-5: Parent session ends with child projections

- **Given:** a parent session exposes open requests owned by children.
- **When:** the parent session ends.
- **Then:** The parent dismisses every remaining projected copy as
  `route-lost`. It does not settle the child-owned requests.
- **Observed:** Every `input.dismissed(scope: projection, reason: route-lost)`
  precedes the parent terminal event.

## What implementation needs

Four structural changes carry all of this:

1. **Pending requests become a collection.** Today one singleton batch holds
   the whole pending state
   ([`input-requests.ts`](../packages/eve/src/harness/input-requests.ts#L394-L405)).
   If a later turn raises its own HITL while an earlier request is open, the
   batch would be overwritten. Key pending requests by `requestId`, each linked
   to its assistant-turn input batch and originating actor.
2. **Requests bind their originating actor.** Snapshot the verified
   `{ authenticator, issuer, principalId }` at request creation. When the
   channel has no verified principal, use a session-local actor key for origin
   comparison without presenting it as verified identity to response policy.
3. **Deliveries keep durable order and actor boundaries.** Assign a monotonic
   arrival sequence before buffering. Coalescing may combine only adjacent
   deliveries with the same actor key.
4. **Session-limit prompts have generations.** A re-prompt increments a
   generation included in the request ID so a response to the prior prompt is
   unambiguously stale.

The acceptance gate for the late splice is an integration test extending
[`tool-loop-generate-approval-resume.integration.test.ts`](../packages/eve/src/harness/tool-loop-generate-approval-resume.integration.test.ts)
with a normal turn between the approval request and its response. SDK core
accepts restoring the assistant-turn approval batch after that intervening
turn; provider converters are the remaining risk to verify.

## Current behavior to remove

The originating actor is not bound to `InputRequest` today. `SessionTurn`
contains only `id` and `sequence`, and `InputRequest` has no actor:

- [`SessionTurn`](../packages/eve/src/channel/types.ts#L76-L85)
- [`InputRequest`](../packages/eve/src/runtime/input/types.ts#L39-L71)

The current harness marks approvals as `"required"` and questions as
`"dismissable"`, without considering the current actor
([`classifyInputRequest`](../packages/eve/src/harness/input-request-class.ts#L27-L44)).

An unrelated message behind a required request is compacted into
`deferredStepInput`; the model is not called and the session waits again
([`input-requests.ts`](../packages/eve/src/harness/input-requests.ts#L150-L162),
[`tool-loop.ts`](../packages/eve/src/harness/tool-loop.ts#L680-L700)).

Questions instead resolve as ignored and the message continues
([`input-requests.ts`](../packages/eve/src/harness/input-requests.ts#L164-L183)).

A runtime action can return before an extracted approval is persisted and
emitted
([`tool-loop.ts`](../packages/eve/src/harness/tool-loop.ts#L2034-L2118)).
Approval extraction also skips a request when its tool-call metadata cannot be
recovered
([`input-extraction.ts`](../packages/eve/src/harness/input-extraction.ts#L146-L151)).
Both paths must recover and expose the request or fail the turn explicitly.

For child agents, descendant cancellation can fail while the parent continues
([`cancel-descendant-turns-step.ts`](../packages/eve/src/execution/cancel-descendant-turns-step.ts#L96-L120)).
The parent currently clears every routed request afterward without telling the
channel
([`settle-cancelled-turn-step.ts`](../packages/eve/src/execution/settle-cancelled-turn-step.ts#L123-L139)).
The parent also drops all prior routes for a child whenever that child raises a
fresh request batch
([`proxy-input-requests.ts`](../packages/eve/src/harness/proxy-input-requests.ts#L44-L66)).
Under this design a child keeps running turns while old requests stay pending,
so routes must accumulate per request and close only with a settlement or
`input.dismissed`.

The server has no authoritative response event. `client.input.responded` is
only a client-side optimistic update
([`ClientInputRespondedEvent`](../packages/eve/src/client/reducer.ts#L33-L52)).

## Closed when this ships

Fixes [#1224](https://github.com/vercel/eve/issues/1224) - freeform reply to a
pending approval mutes the session forever.
Fixes [#1201](https://github.com/vercel/eve/issues/1201) - approval silently
dropped when a step also requests a subagent call.
Fixes [#1608](https://github.com/vercel/eve/issues/1608) - duplicate input
response resumes a disposed child hook and fails the parent.

## Related, not closed by this

- [#786](https://github.com/vercel/eve/issues/786) - consumed-as-answer half
  is fixed; mid-turn steering is out of scope.
- [#1095](https://github.com/vercel/eve/issues/1095) - settlement events are
  PR #1368.
- [#1021](https://github.com/vercel/eve/issues/1021) - responder
  authorization, owned by PR #1368.
- [#1658](https://github.com/vercel/eve/issues/1658) - OpenAI provider
  transcript-shape bug; not fixed here.

## Related work

- [PR #1368](https://github.com/vercel/eve/pull/1368): responder identity,
  authorization, Allow, Cancel, and request settlement.
- [PR #1231](https://github.com/vercel/eve/pull/1231): makes every message
  replace unresolved input. Replacing another actor's request breaks ownership.
- [PR #142](https://github.com/vercel/eve/pull/142): Slack-specific responder
  enforcement.

## Staging

Five PRs plus the eval matrix. Each lands alone, each has its own test gate.

The decision logic stays a small pure function — settle correlated authorized
responses, reject stale ones, let unrelated messages run, apply question
supersession — extracted from `resolvePendingInput` in the PR that uses it,
not staged as a standalone module. A module with no consumer is dead code
waiting to drift, and evals must not import it: an eval that asserts the
policy's own output proves nothing. Expected outcomes live in tests as
literal event-sequence expectations.

### 1. Acceptance gate

Extend
[`tool-loop-generate-approval-resume.integration.test.ts`](../packages/eve/src/harness/tool-loop-generate-approval-resume.integration.test.ts)
with a normal turn between the approval request and its response. This
falsifies the late-splice bet against real providers before anything is built.
No runtime changes.

### 2. Data: per-request collection

Replace the singleton pending batch with ordered assistant-turn input batches.
Each request links to its batch and originating actor
`{ authenticator, issuer, principalId }`; each batch stores the model output
once. Resolution behavior stays exactly as today — this PR is a pure data
refactor, verified by the existing suite passing unchanged.

### 3. Behavior: non-blocking resolution

Rewrite `resolvePendingInput`: the decision logic becomes a pure function in
the same area; transcript assembly applies its decisions. Deletes the
`deferredStepInput` gating path. Unrelated messages run; requests stay
pending; late responses restore their assistant-turn batch; batches close as a
unit; `ask_question` supersession; stale means not-pending. Unit tests are the scenario matrix as
literal tables. Fixes #1224 and the consumed-as-answer half of #786.

### 4. Lifecycle events

The three input lifecycle events; fail-closed request creation on the
runtime-action and metadata-loss paths (fixes #1201); session-limit generations
and re-prompt closure; nonblocking authorization scheduling plus correct turn
boundaries and completion timing.

### 5. Multiplayer and routing

Actor partitioning in delivery coalescing; proxy routes accumulate per request
and close only via settlement or `input.dismissed(route-lost)`. Fixes #1608.

### 6. Eval matrix

One e2e fixture with a deterministic mock model and a two-principal custom
channel. It covers every applicable normative scenario ID. Expected event
sequences are written literally and never computed from runtime code. These
dimensions are coverage tags, not a Cartesian product:

| Dimension      | Values                                                        |
| -------------- | ------------------------------------------------------------- |
| Players        | single-player, two principals                                 |
| Request kind   | approval, question, session-limit, authorization              |
| Batch          | single request, assistant-turn input batch                    |
| Delivery       | structured response, plain message, response + message        |
| Actor relation | originating actor, other actor                                |
| Timing         | while waiting, after intervening turns, after closure (stale) |

Authorization scenarios assert only applicable rows. Unlike input requests,
authorization challenges are not members of assistant-turn input batches.
AU-1 requires new nonblocking driver scheduling; current callback-only waiting
does not satisfy it.
