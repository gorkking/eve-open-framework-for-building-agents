# HITL lifecycle scenario coverage

Executable form of the normative scenarios in
`research/hitl-request-lifecycle.md`. Evals here are gated by
`EVE_HITL_LIFECYCLE_CONTRACT=1` and skip until the behavior and
lifecycle-event stages land. “Gated” means an acceptance test exists but does
not execute yet; “partial” names existing evidence that does not prove the full
scenario; “planned” names the intended tier without claiming coverage.
Every gated scenario sends another ordinary message through the same session,
requires its model response, and then requires another `session.waiting`
boundary with no completion or failure boundary.

Families: `approval` (human consent for a tool call, including batch, timing,
and creation mechanics), `question` (`ask_question`), `limit` (session-limit
prompts), `auth` (connection authorization — OAuth credentials, not consent),
`proxy` (child-owned requests routed through parents), `cancellation` (turn
and session closure).

| Scenario                                                                                            | Status  | Owner or evidence                                                                  | Missing before activation                                       |
| --------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| owner.approval.response.settle-allow                                                                | Gated   | `structured-approval.eval.ts`                                                      | Behavior and lifecycle events                                   |
| owner.approval.response.settle-allow-other-actor                                                    | Gated   | `other-principal-approves.eval.ts`                                                 | Lifecycle events                                                |
| owner.approval.response.reject-unauthorized                                                         | Blocked | Response-authorizer API                                                            | Unauthorized response policy                                    |
| owner.approval.message.run-open (other actor)                                                       | Gated   | `other-principal-message.eval.ts`                                                  | Nonblocking messages and lifecycle events                       |
| owner.approval.message.run-open (originating actor)                                                 | Gated   | `message-then-late-approval.eval.ts`                                               | Nonblocking message behavior                                    |
| owner.approval.response.settle-allow-after-turns                                                    | Partial | `message-then-late-approval.eval.ts`                                               | Integration-level committed-history ordering                    |
| owner.approval.message.run-open (option-like text)                                                  | Gated   | `plain-text-does-not-approve.eval.ts`                                              | Structured-only response behavior                               |
| owner.approval.compound.settle-then-run                                                             | Partial | `approval-and-message-together.eval.ts`                                            | Restored/resumed assistant-output boundaries                    |
| owner.approval.compound.settle-then-run-siblings-open                                               | Planned | Unit tier in `input-requests.test.ts`                                              | Compound message with an unsettled sibling request              |
| owner.approval.response.reject-stale                                                                | Gated   | `duplicate-response-after-closure.eval.ts`                                         | Stale-attempt turn context and lifecycle events                 |
| owner.approval.compound.reject-stale-then-run                                                       | Gated   | `stale-response-with-message.eval.ts`                                              | Compound stale-response behavior                                |
| owner.approval.response.settle-cancel, owner.approval.response.settle-race                          | Blocked | PR #1368                                                                           | Cancel decision and atomic race                                 |
| owner.approval.response.settle-race (two responders)                                                | Blocked | Multiplayer fixture and PR #1368                                                   | Two allowed responders racing                                   |
| owner.approval.response.reject-policy-failed, owner.approval.response.reject-invalid                | Planned | Unit resolver tier                                                                 | Policy failure, timeout, and invalid-value cases                |
| owner.approval.response.pend-authorization, owner.approval.response.settle-cancel-pending-candidate | Blocked | PR #1368                                                                           | Durable authorization-required candidates                       |
| owner.batch.response.settle-partial, owner.batch.close.fire-continuation                            | Partial | `partial-then-complete-request-batch.eval.ts`                                      | Committed-history and non-allowed closure variants              |
| owner.batch.park.append                                                                             | Partial | `independent-request-batches.eval.ts`                                              | Exact question-result non-replay                                |
| owner.approval.message.no-retroactive-binding                                                       | Planned | Integration arrival-order tier                                                     | Delivery/request-creation race injection                        |
| owner.approval.response.settle-allow-anonymous                                                      | Partial | `structured-approval.eval.ts` anonymous path                                       | Policy-observed null responder and cross-session origin check   |
| scheduler.delivery.admit-actor-partition                                                            | Blocked | Multiplayer-stage two-principal fixture                                            | Actor-homogeneous buffered delivery partitioning                |
| owner.batch.park.persist-with-runtime-action, owner.batch.park.fail-closed-metadata                 | Planned | Tool-loop integration tier                                                         | Runtime-action collision and fail-closed metadata loss          |
| owner.question.response.settle-answer                                                               | Partial | `../hitl/ask-question-select.eval.ts`                                              | `input.responded(answered)` identity and cardinality            |
| owner.question.message.dismiss-superseded                                                           | Gated   | `message-supersedes-question.eval.ts`                                              | Owner-declared supersession                                     |
| owner.question.message.run-open-other-actor                                                         | Gated   | `other-principal-does-not-supersede-question.eval.ts`                              | Non-originating actor behavior                                  |
| owner.question.compound.settle-then-run                                                             | Gated   | `answer-and-message-together.eval.ts`                                              | Compound answer/message behavior                                |
| owner.batch.message.dismiss-question-only                                                           | Planned | Unit mixed-batch tier                                                              | Question-only supersession while approval sibling remains open  |
| owner.limit.message.supersede, owner.limit.response.reject-stale                                    | Gated   | `agent-session-limits/.../session-token-limit-reprompt-lifecycle.eval.ts`          | Re-prompt and stale lifecycle behavior                          |
| owner.limit.response.settle-continue, owner.limit.response.settle-stop                              | Gated   | `agent-session-limits/.../session-token-limit-response-lifecycle.eval.ts`          | Continue/Stop lifecycle behavior                                |
| owner.auth.message.run-open                                                                         | Gated   | `../auth/message-while-authorization-open.eval.ts`                                 | Nonblocking authorization scheduling                            |
| owner.auth.callback.complete                                                                        | Partial | `../auth/authorization-callback.eval.ts`                                           | Other outcomes, candidate mappings, and stable authorization ID |
| owner.auth.deadline.complete-timed-out                                                              | Gated   | `../auth/authorization-deadline.eval.ts`                                           | Deadline and stale-callback lifecycle                           |
| owner.auth.close.complete                                                                           | Blocked | Session/turn authorization finalizers                                              | Cancel, completion, failure, and termination mappings           |
| projector.route.park.project                                                                        | Covered | `subagent-hitl-proxy.integration.test.ts` + `agent-subagents-hitl/approve.eval.ts` | —                                                               |
| projector.route.drop.route-lost                                                                     | Blocked | Route-disposal lifecycle seam                                                      | Route-loss projection before removal                            |
| projector.route.close.project                                                                       | Partial | `agent-subagents-hitl/reject.eval.ts`                                              | Projected closure, route cleanup, and sibling preservation      |
| projector.route.response.reject-stale-after-drop, projector.route.response.forward-responder        | Blocked | Disposed-hook and response-authorizer seams                                        | Closure race and responder-policy projection                    |
| projector.route.response.reject-unauthorized-remote                                                 | Blocked | Remote interactive-HITL protocol                                                   | Forwarded response proof rejection                              |
| owner.obligation.turn-cancel.dismiss                                                                | Blocked | Per-turn request collection and active-turn barrier                                | Owner-request cancellation                                      |
| owner.obligation.session-end.dismiss                                                                | Blocked | Session finalizer with request state                                               | Session-end closure ordering                                    |
| projector.route.drop.route-lost                                                                     | Blocked | Graceful parent-session termination seam                                           | Parent terminal event and projected route-loss ordering         |
| owner.batch.forced-close.no-continuation                                                            | Blocked | Same finalizer seams as owner.obligation.turn-cancel.dismiss/2                     | No-restoration proof after forced closure                       |

Existing evals in `../hitl/` that assert the pre-contract behavior —
`text-approve`, `unrelated-message-queued`, `authored-always-unrelated-input`,
`stale-ask-question-selection*` — are superseded by these scenarios and retire
in the behavior stage.

`../hitl/approval-resume-token.eval.ts` separately proves that
`ToolContext.getToken()` remains available after approval resume.
