# HITL transition coverage

Executable evidence for the transition catalog in
`research/hitl-request-lifecycle.md`. Each eval declares its catalog identity
in `metadata.transition` or `metadata.transitions`; descriptions are for
humans, not identity.

Evals tagged `hitl-lifecycle` are gated by
`EVE_HITL_LIFECYCLE_CONTRACT=1` until the interpreter and lifecycle-event
stages land. **Gated** means executable target-state evidence exists;
**Partial** means the listed evidence does not prove the whole transition;
**Planned** names the intended tier without claiming evidence; **Blocked**
names a missing runtime seam.

Catalog namespaces: `owner.approval`, `owner.question`, `owner.batch`,
`owner.limit`, `owner.auth`, `owner.obligation`, `scheduler.delivery`, and
`projector.route`.

## Implementation-stage gates

Every implementation PR must pass its stage gate before the next stage begins.
A store or pure-interpreter extraction has no distinct HTTP behavior, so its
acceptance evidence is the narrow executable unit matrix. Once a stage changes
session behavior, its gate includes fixture-owned evals; unit coverage alone is
not sufficient.

| Stage                            | Required executable evidence                                                                                                                                                                                                                                                                                 | Activation criterion                                                                                                                                                                  |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1 · Store foundation             | `pnpm --filter eve exec vitest run --config vitest.unit.config.ts src/harness/interaction/obligations.test.ts`                                                                                                                                                                                               | Legacy batches migrate and reload without loss; uncut authorization, route, and deferred-input keys remain owned by their current paths; ledger invariants reject invalid references. |
| 2 · Interpreter extraction       | `pnpm --filter eve exec vitest run --config vitest.unit.config.ts src/harness/interaction/obligations.test.ts src/harness/interaction/interpret.test.ts src/harness/interaction/execute.test.ts src/harness/interaction/delivery.test.ts`; one literal state/input/decision case per migrated transition row | Legacy comparisons pass; real admission identity reaches the interpreter; approval candidates require adjudication; persisted effect plans resume at the first incomplete effect.     |
| 3 · Auth integration             | `../auth/authorization-callback.eval.ts`, `../auth/authorization-deadline.eval.ts`, plus interpreter cases for each challenge outcome                                                                                                                                                                        | Run the auth evals with their stage gate enabled; callback, timeout, and late-callback traces match the catalog.                                                                      |
| 4 · Single stream and projection | `../auth/message-while-authorization-open.eval.ts`, `agent-subagents-hitl/approve.eval.ts`, `agent-subagents-hitl/deny.eval.ts`, and arrival-order integration coverage                                                                                                                                      | Ordinary input and callbacks are both admitted while challenges are open; projected routes preserve request identity.                                                                 |
| 5 · Target semantics             | The `evals/lifecycle/*.eval.ts` files mapped below and the session-limit lifecycle evals                                                                                                                                                                                                                     | Enable only transitions implemented by the PR; each enabled eval must pass before widening the gate.                                                                                  |
| 6 · Lifecycle events             | Entire `hitl-lifecycle` eval catalog with `EVE_HITL_LIFECYCLE_CONTRACT=1`                                                                                                                                                                                                                                    | Literal event cardinality, identity, coordinates, and ordering pass across the complete catalog.                                                                                      |

Stage 1 deliberately has no new E2E file: the ledger is not read by production
adapters yet, so an HTTP eval cannot distinguish it from its absence. Claiming
E2E coverage here would test existing behavior rather than the new state
boundary. Stage 1's round-trip migration test is therefore the acceptance gate;
fixture evals become mandatory at the first observable cutover.

| Transition                                              | Status  | Owner or evidence                                                                                                                          | Missing before activation                                     |
| ------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| owner.approval.response.settle-allow                    | Partial | `../hitl/interaction-approval-cutover.eval.ts` (active deterministic cutover gate); `structured-approval.eval.ts` (gated lifecycle events) | Remaining lifecycle events                                    |
| owner.approval.response.settle-allow-other-actor        | Gated   | `other-principal-approves.eval.ts`                                                                                                         | Lifecycle events                                              |
| owner.approval.response.settle-allow-anonymous          | Planned | Interpreter unit matrix + anonymous channel eval                                                                                           | Policy-observed null responder and cross-session origin check |
| owner.approval.response.settle-deny                     | Gated   | `stale-response-with-message.eval.ts`; behavioral supplement `../hitl/deny-then-regate.eval.ts`                                            | Lifecycle events                                              |
| owner.approval.response.reject-unauthorized             | Blocked | Response-authorizer API                                                                                                                    | Unauthorized policy result                                    |
| owner.approval.message.run-open                         | Gated   | `message-then-late-approval.eval.ts`, `other-principal-message.eval.ts`, `plain-text-does-not-approve.eval.ts`                             | Interpreter behavior + lifecycle events                       |
| owner.approval.response.settle-allow-after-turns        | Partial | `message-then-late-approval.eval.ts`                                                                                                       | Integration-level committed-history ordering                  |
| owner.approval.compound.settle-then-run                 | Partial | `approval-and-message-together.eval.ts`                                                                                                    | Restored/resumed output boundaries                            |
| owner.approval.compound.settle-then-run-siblings-open   | Planned | `interaction/interpret.test.ts`                                                                                                            | Compound message with an open sibling                         |
| owner.approval.response.reject-stale                    | Gated   | `duplicate-response-after-closure.eval.ts`                                                                                                 | Stale-attempt events                                          |
| owner.approval.compound.reject-stale-then-run           | Gated   | `stale-response-with-message.eval.ts`                                                                                                      | Compound stale-response behavior                              |
| owner.approval.response.settle-cancel                   | Blocked | PR #1368                                                                                                                                   | Cancel decision                                               |
| owner.approval.response.settle-race                     | Blocked | PR #1368 + two-responder race fixture                                                                                                      | Atomic single winner                                          |
| owner.approval.response.reject-policy-failed            | Planned | `interaction/interpret.test.ts`                                                                                                            | Policy throw/timeout result                                   |
| owner.approval.response.reject-invalid                  | Planned | `interaction/interpret.test.ts`                                                                                                            | Invalid-value result                                          |
| owner.approval.response.pend-authorization              | Blocked | PR #1368                                                                                                                                   | Durable authorization-required candidate                      |
| owner.approval.response.settle-cancel-pending-candidate | Blocked | PR #1368                                                                                                                                   | Candidate cancellation + stale callback                       |
| owner.batch.response.settle-partial                     | Gated   | `partial-then-complete-request-batch.eval.ts`                                                                                              | Interpreter behavior + lifecycle events                       |
| owner.batch.close.fire-continuation                     | Partial | `partial-then-complete-request-batch.eval.ts`                                                                                              | Non-allowed closure variants                                  |
| owner.batch.park.append                                 | Gated   | `independent-request-batches.eval.ts`                                                                                                      | Interpreter behavior + lifecycle events                       |
| owner.batch.park.dedupe-open-intent                     | Planned | `interaction/interpret.test.ts` + park-side intent index                                                                                   | Open-approval intent-key check at park                        |
| owner.approval.message.no-retroactive-binding           | Planned | Arrival-order integration tier                                                                                                             | Delivery/request-creation race injection                      |
| scheduler.delivery.admit-arrival-order                  | Gated   | `agent-session-limits/.../session-token-limit-approve.eval.ts`                                                                             | Active-turn FIFO admission + lifecycle behavior               |
| scheduler.delivery.admit-actor-partition                | Blocked | Two-principal fixture exists                                                                                                               | Buffered A/B/A admission-order injection                      |
| owner.batch.park.persist-with-runtime-action            | Planned | Tool-loop integration tier                                                                                                                 | Runtime-action collision                                      |
| owner.batch.park.fail-closed-metadata                   | Planned | Tool-loop integration tier                                                                                                                 | Metadata-loss injection                                       |
| owner.question.response.settle-answer                   | Partial | `../hitl/interaction-question-cutover.eval.ts` (active deterministic cutover gate); `../hitl/ask-question-select.eval.ts`                  | Lifecycle identity/cardinality                                |
| owner.question.response.reject-stale                    | Gated   | `stale-question-response.eval.ts`                                                                                                          | Interpreter behavior + lifecycle events                       |
| owner.question.message.dismiss-superseded               | Partial | `../hitl/interaction-question-cutover.eval.ts` (active deterministic cutover gate); `message-supersedes-question.eval.ts`                  | Lifecycle event                                               |
| owner.question.message.run-open-other-actor             | Gated   | `other-principal-does-not-supersede-question.eval.ts`                                                                                      | Actor guard                                                   |
| owner.question.compound.settle-then-run                 | Gated   | `answer-and-message-together.eval.ts`                                                                                                      | Compound behavior                                             |
| owner.batch.message.dismiss-question-only               | Planned | `interaction/interpret.test.ts`                                                                                                            | Mixed-group supersession                                      |
| owner.limit.message.supersede                           | Gated   | `agent-session-limits/.../session-token-limit-reprompt-lifecycle.eval.ts`                                                                  | Prompt generation + lifecycle events                          |
| owner.limit.response.reject-stale                       | Gated   | same                                                                                                                                       | Stale lifecycle event                                         |
| owner.limit.response.settle-continue                    | Partial | `agent-session-limits/.../session-token-limit-continuation.eval.ts` (active deterministic cutover gate); lifecycle eval                    | Continue lifecycle event                                      |
| owner.limit.response.settle-stop                        | Partial | same                                                                                                                                       | Stop lifecycle event                                          |
| owner.auth.message.run-open                             | Gated   | `../auth/message-while-authorization-open.eval.ts`                                                                                         | Single-stream scheduling                                      |
| owner.auth.callback.complete                            | Partial | `../auth/authorization-callback.eval.ts`                                                                                                   | Outcomes other than authorized                                |
| owner.auth.deadline.complete-timed-out                  | Gated   | `../auth/authorization-deadline.eval.ts`                                                                                                   | Deadline producer + lifecycle event                           |
| owner.auth.callback.reject-stale                        | Gated   | same                                                                                                                                       | Stale callback event                                          |
| owner.auth.close.complete                               | Blocked | Session/turn challenge finalizers                                                                                                          | Cancel/completion/failure mappings                            |
| projector.route.park.project                            | Covered | `subagent-hitl-proxy.integration.test.ts` + `agent-subagents-hitl/approve.eval.ts`                                                         | —                                                             |
| projector.route.close.project                           | Partial | `agent-subagents-hitl/deny.eval.ts`                                                                                                        | Route cleanup + sibling preservation                          |
| projector.route.drop.route-lost                         | Blocked | Projector route-disposal and parent-termination seams                                                                                      | Dismiss before route removal                                  |
| projector.route.response.reject-stale-after-drop        | Blocked | Disposed-hook seam                                                                                                                         | Closure race                                                  |
| projector.route.response.forward-responder              | Blocked | Response-authorizer seam                                                                                                                   | Identity-preserving forward                                   |
| projector.route.response.reject-unauthorized-remote     | Blocked | Remote interactive-HITL protocol                                                                                                           | Forwarded proof rejection                                     |
| owner.obligation.turn-cancel.dismiss                    | Blocked | Per-turn obligation collection                                                                                                             | Owner-turn cancellation ordering                              |
| owner.obligation.session-end.dismiss                    | Blocked | Session finalizer                                                                                                                          | Session-end ordering                                          |
| owner.batch.forced-close.no-continuation                | Blocked | Same finalizer seams                                                                                                                       | No-restoration proof                                          |

Pre-machine evals that asserted runtime text matching, approval-message
queueing, stale-question-as-message conversion, or limit-prompt preservation
have been removed. Their gated replacements above are the only acceptance
evidence for those transitions.

`../hitl/approval-resume-token.eval.ts` is supplementary evidence that
`ToolContext.getToken()` remains available after
`owner.approval.response.settle-allow`; it does not claim lifecycle-event
coverage.
