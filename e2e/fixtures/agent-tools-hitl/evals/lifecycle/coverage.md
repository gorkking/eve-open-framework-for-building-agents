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

| Scenario                  | Status  | Owner or evidence                                                                  | Missing before activation                                       |
| ------------------------- | ------- | ---------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| approval-1                | Gated   | `structured-approval.eval.ts`                                                      | Behavior and lifecycle events                                   |
| approval-2                | Gated   | `other-principal-approves.eval.ts`                                                 | Lifecycle events                                                |
| approval-3                | Blocked | Response-authorizer API                                                            | Unauthorized response policy                                    |
| approval-5                | Gated   | `other-principal-message.eval.ts`                                                  | Nonblocking messages and lifecycle events                       |
| approval-4                | Gated   | `message-then-late-approval.eval.ts`                                               | Nonblocking message behavior                                    |
| approval-8                | Partial | `message-then-late-approval.eval.ts`                                               | Integration-level committed-history ordering                    |
| approval-6                | Gated   | `plain-text-does-not-approve.eval.ts`                                              | Structured-only response behavior                               |
| approval-7                | Partial | `approval-and-message-together.eval.ts`                                            | Restored/resumed assistant-output boundaries                    |
| approval-7b               | Planned | Unit tier in `input-requests.test.ts`                                              | Compound message with an unsettled sibling request              |
| approval-9, approval-14   | Gated   | `duplicate-response-after-closure.eval.ts`                                         | Stale-attempt turn context and lifecycle events                 |
| approval-10               | Gated   | `stale-response-with-message.eval.ts`                                              | Compound stale-response behavior                                |
| approval-11, approval-12  | Blocked | PR #1368                                                                           | Cancel decision and atomic race                                 |
| approval-13               | Blocked | Multiplayer fixture and PR #1368                                                   | Two allowed responders racing                                   |
| approval-15, approval-15b | Planned | Unit resolver tier                                                                 | Policy failure, timeout, and invalid-value cases                |
| approval-16, approval-17  | Blocked | PR #1368                                                                           | Durable authorization-required candidates                       |
| approval-18, approval-19  | Partial | `partial-then-complete-request-batch.eval.ts`                                      | Committed-history and non-allowed closure variants              |
| approval-20               | Partial | `independent-request-batches.eval.ts`                                              | Exact question-result non-replay                                |
| approval-21               | Planned | Integration arrival-order tier                                                     | Delivery/request-creation race injection                        |
| approval-22               | Partial | `structured-approval.eval.ts` anonymous path                                       | Policy-observed null responder and cross-session origin check   |
| approval-23               | Blocked | Multiplayer-stage two-principal fixture                                            | Actor-homogeneous buffered delivery partitioning                |
| approval-24, approval-25  | Planned | Tool-loop integration tier                                                         | Runtime-action collision and fail-closed metadata loss          |
| question-1                | Partial | `../hitl/ask-question-select.eval.ts`                                              | `input.responded(answered)` identity and cardinality            |
| question-2                | Gated   | `message-supersedes-question.eval.ts`                                              | Owner-declared supersession                                     |
| question-3                | Gated   | `other-principal-does-not-supersede-question.eval.ts`                              | Non-originating actor behavior                                  |
| question-4                | Gated   | `answer-and-message-together.eval.ts`                                              | Compound answer/message behavior                                |
| question-5                | Planned | Unit mixed-batch tier                                                              | Question-only supersession while approval sibling remains open  |
| limit-1, limit-4          | Gated   | `agent-session-limits/.../session-token-limit-reprompt-lifecycle.eval.ts`          | Re-prompt and stale lifecycle behavior                          |
| limit-2, limit-3          | Gated   | `agent-session-limits/.../session-token-limit-response-lifecycle.eval.ts`          | Continue/Stop lifecycle behavior                                |
| auth-1                    | Gated   | `../auth/message-while-authorization-open.eval.ts`                                 | Nonblocking authorization scheduling                            |
| auth-2                    | Partial | `../auth/authorization-callback.eval.ts`                                           | Other outcomes, candidate mappings, and stable authorization ID |
| auth-3 deadline           | Gated   | `../auth/authorization-deadline.eval.ts`                                           | Deadline and stale-callback lifecycle                           |
| auth-3 other closures     | Blocked | Session/turn authorization finalizers                                              | Cancel, completion, failure, and termination mappings           |
| proxy-1                   | Covered | `subagent-hitl-proxy.integration.test.ts` + `agent-subagents-hitl/approve.eval.ts` | —                                                               |
| proxy-2                   | Blocked | Route-disposal lifecycle seam                                                      | Route-loss projection before removal                            |
| proxy-3                   | Partial | `agent-subagents-hitl/reject.eval.ts`                                              | Projected closure, route cleanup, and sibling preservation      |
| proxy-4, proxy-5          | Blocked | Disposed-hook and response-authorizer seams                                        | Closure race and responder-policy projection                    |
| proxy-6                   | Blocked | Remote interactive-HITL protocol                                                   | Forwarded response proof rejection                              |
| cancellation-1            | Blocked | Per-turn request collection and active-turn barrier                                | Owner-request cancellation                                      |
| cancellation-2            | Blocked | Session finalizer with request state                                               | Session-end closure ordering                                    |
| cancellation-3            | Blocked | Graceful parent-session termination seam                                           | Parent terminal event and projected route-loss ordering         |
| cancellation-4            | Blocked | Same finalizer seams as cancellation-1/2                                           | No-restoration proof after forced closure                       |

Existing evals in `../hitl/` that assert the pre-contract behavior —
`text-approve`, `unrelated-message-queued`, `authored-always-unrelated-input`,
`stale-ask-question-selection*` — are superseded by these scenarios and retire
in the behavior stage.

`../hitl/approval-resume-token.eval.ts` separately proves that
`ToolContext.getToken()` remains available after approval resume.
