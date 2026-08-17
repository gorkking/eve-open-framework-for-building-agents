---
issue: https://github.com/vercel/eve/issues/1224
status: proposed
last_updated: "2026-08-17"
---

# HITL admission invariants

## Decision

Four invariants govern the seam between admission and the model, now
normative as invariants 1–4 in
[hitl-request-lifecycle.md](./hitl-request-lifecycle.md#interpretation):

1. **Admission never blocks.** Obligations are data, never control flow;
   buffering during `TurnActive` is ordering, never refusal.
2. **Admission does not necessarily invoke the model.** A model call happens
   only via a `run-model` effect or a claimed continuation at group closure;
   everything else is absorbed by ledger transitions and events.
3. **Every invoked model turn receives a safe projection of open
   obligations.** Withheld output of open groups appears zero times; nothing
   is fabricated for unsettled obligations; non-settling attempts enter only
   as synthetic context messages.
4. **A newly raised approval is checked against open approval intent before
   append.** One settlement adjudicates one intent once.

This document is the decision record: what the consolidation changed in the
spec, the tradeoffs, and the one resolution still open. The lifecycle
contract stays the normative source; nothing here is.

## Spec changes the consolidation forced

Each row is a change the invariants made unavoidable once stated together.

| Change | Where | Evidence |
| ------ | ----- | -------- |
| Removed the claim "every admitted delivery also initiates a turn" (old invariant 6) | invariant 2 | a partial settlement emits only `record-response`, no `run-model` ([interpret.ts](../packages/eve/src/harness/hitl/interpret.ts#L264-L287)) |
| `settle-race`'s loser formally reduces to `reject-stale` | `owner.approval.response.settle-race` | single-winner serializes candidates; the second is interpreted against a settled tombstone |
| Stale-response asymmetry made explicit: approval/question stale attempts become a synthetic context message plus a turn; stale limit answers are dropped outright | `reject-stale` rows vs `owner.limit.response.reject-stale` | the tool loop's two-pass comment: "drop what must never reach the model (session-limit continuation answers), then convert what should reach it as plain text" ([tool-loop.ts](../packages/eve/src/harness/tool-loop.ts)) |
| A message during an open limit prompt never enters history and is never replayed | `owner.limit.message.supersede` | the prompt exists to stop spend; replay would spend |
| Compound allow+message is two model calls (closure resume, then message turn); question supersession is one | `owner.approval.compound.settle-then-run`, `owner.question.message.dismiss-superseded` | supersession restores only a dismissal outcome part — there is no resume phase to serialize before the message |
| Projection is events-only: the parent's history never changes and the parent runs no model turn for projector traffic | `projector.*` preamble | forwarding is transport; the child owns the obligation |
| New row `owner.batch.park.dedupe-open-intent`, mirrored as store invariant 9 in [hitl-engine.md](./hitl-engine.md#invariants) | invariant 4 | no open-intent check exists in code today; this is target state |

## Open decision: duplicate intent at park

Invariants 1 and 3 jointly cause the problem invariant 4 solves. Because a
message runs while an approval is open (1) and the model cannot see its own
withheld attempt (3), the model will predictably re-raise the same tool call
in the new turn. Without a check, one intent produces N approval cards, and
approving one runs the tool while the others stay open.

### Intent key derivation

Deduping on the granted-approval default — `approvalKey(toolInput) ?? toolName`
([execute-tool.ts](../packages/eve/src/harness/execute-tool.ts#L23),
[tool-loop.ts](../packages/eve/src/harness/tool-loop.ts#L3050-L3058)) — is
wrong for *open* intent: under the tool-name default, a new `bash rm -rf`
approval would be swallowed by an unrelated open `bash ls` approval and
answered "already pending". The contract therefore compares only **authored**
keys; tools without `approvalKey` never share an intent, and a duplicate card
is the fail-open default. Criteria: correctness over convenience — a
redundant card annoys, a wrongly-coalesced card silently blocks a distinct
action.

### Resolution of the duplicate raise

| Option | Pros | Cons |
| ------ | ---- | ---- |
| **(a) Close the duplicate call with a synthetic already-pending result naming the open request** — current contract | Model reacts immediately, like a denied tool; no cross-group state; one card per intent | The duplicate call site never runs, even after the open approval settles as allowed — the model must re-raise after settlement if it still wants the action |
| (b) Bind the duplicate call site to the open obligation; one settlement resolves both | No lost call site; user answers once | Breaks "every obligation belongs to exactly one group" (engine invariant 2); the second group's closure now depends on a foreign member; replay and forced-closure semantics multiply |
| (c) Fail the park | Simplest; loudly fail-closed | Hostile: an ordinary chat message plus a model retry kills the turn; punishes the user for invariant-1 behavior |

Recommendation: **(a)**, already written into the row. It is the only option
that keeps the group model intact (blast radius: interpreter-only) and stays
reversible — (b) can be layered later if re-raise-after-settlement proves
common enough to matter.

### Alternative that would shrink invariant 4: a pending marker

Instead of hiding open approvals entirely, the safe projection could include
a synthetic note — "approval `A1` for `bash npm publish` is pending" — making
re-raises unlikely rather than deduped. Pros: attacks the cause, not the
symptom; no intent-key machinery. Cons: model compliance is probabilistic, so
invariant 4 is still needed as the hard guarantee; the note is new prompt
surface with injection-adjacent risk near consent flows. Verdict: compatible
future addition, not a replacement — invariant 4 stays.

## Tradeoffs of the consolidation

**Pros.**

- The model-invocation policy is enumerable: invariant 2 lists every
  no-model transition, so "does this delivery call the model?" is a table
  lookup, reviewable per interpreter row.
- The wedge class dies by construction (invariant 1), not by fixing wedges
  one at a time; the two shipped mitigations become instances of a rule.
- Transcript safety is checkable (invariant 3): provider-valid transcripts,
  no leaked un-consented tool calls, no stale text reinterpreted as consent.
- Each invariant has a mechanical twin in
  [hitl-engine.md](./hitl-engine.md#invariants), so drift between contract
  and store is testable.

**Costs.**

- Invariant 2 weakens the old blanket guarantee: a partial settlement now
  produces no agent reaction, only lifecycle events. A channel that renders
  no lifecycle events shows silence where users previously always got a
  reply. Mitigation: settlement events are mandatory in `Observed`, so a
  conforming channel always has something to render.
- Invariant 3's blindness is what makes invariant 4 necessary — the pair is
  more machinery than either alone. Accepted because the alternative
  (showing the model its withheld attempt) risks invalid provider
  transcripts and consent-adjacent prompt surface.
- Invariant 4's guarantee is only as good as authored `approvalKey`
  functions; unkeyed tools keep duplicate-card behavior. Accepted as
  fail-open by design (see key derivation above).

## Ownership

- [hitl-request-lifecycle.md](./hitl-request-lifecycle.md) — the normative
  contract: invariants, transition catalog, events.
- [hitl-engine.md](./hitl-engine.md) — implementation boundary and
  machine-checkable store/interpreter invariants.
- This document — rationale and alternatives only; supersede it freely when
  a decision above is ratified or reversed.
