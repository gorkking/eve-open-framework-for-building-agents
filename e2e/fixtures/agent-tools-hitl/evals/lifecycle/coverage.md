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

| Scenario                           | Status  | Owner or evidence                             | Missing before activation                                              |
| ---------------------------------- | ------- | --------------------------------------------- | ---------------------------------------------------------------------- |
| approval-1                         | Gated   | `structured-approval.eval.ts`                 | Behavior and lifecycle events                                          |
| approval-2, approval-3, approval-5 | Blocked | Multiplayer-stage two-principal fixture       | Authored principals and response policy                                |
| approval-4, approval-8             | Gated   | `message-then-late-approval.eval.ts`          | Nonblocking messages and late batch restoration                        |
| approval-6                         | Gated   | `plain-text-does-not-approve.eval.ts`         | Structured-only response behavior                                      |
| approval-7                         | Gated   | `approval-and-message-together.eval.ts`       | Compound delivery behavior                                             |
| approval-7b                        | Planned | Unit tier in `input-requests.test.ts`         | Compound message with an unsettled sibling request                     |
| approval-9, approval-14            | Gated   | `duplicate-response-after-closure.eval.ts`    | Stale-attempt turn context and lifecycle events                        |
| approval-10                        | Gated   | `stale-response-with-message.eval.ts`         | Compound stale-response behavior                                       |
| approval-11, approval-12           | Blocked | PR #1368                                      | Cancel decision and atomic race                                        |
| approval-13                        | Blocked | Multiplayer fixture and PR #1368              | Two allowed responders racing                                          |
| approval-15, approval-15b          | Planned | Unit resolver tier                            | Policy failure, timeout, and invalid-value cases                       |
| approval-16, approval-17           | Blocked | PR #1368                                      | Durable authorization-required candidates                              |
| approval-18, approval-19           | Gated   | `partial-then-complete-request-batch.eval.ts` | Per-request batch collection and restoration                           |
| approval-20                        | Gated   | `independent-request-batches.eval.ts`         | Multiple independently addressable batches                             |
| approval-21                        | Planned | Integration arrival-order tier                | Delivery/request-creation race injection                               |
| approval-22                        | Planned | No-principal fixture                          | Session-local origin fallback assertions                               |
| approval-23                        | Blocked | Multiplayer-stage two-principal fixture       | Actor-homogeneous buffered delivery partitioning                       |
| approval-24, approval-25           | Planned | Tool-loop integration tier                    | Runtime-action collision and fail-closed metadata loss                 |
| question-1                         | Partial | `../hitl/ask-question-select.eval.ts`         | `input.responded(answered)` identity and cardinality                   |
| question-2                         | Gated   | `message-supersedes-question.eval.ts`         | Owner-declared supersession                                            |
| question-3                         | Blocked | Multiplayer-stage two-principal fixture       | Non-originating actor message                                          |
| question-4                         | Gated   | `answer-and-message-together.eval.ts`         | Compound answer/message behavior                                       |
| question-5                         | Planned | Unit mixed-batch tier                         | Question-only supersession while approval sibling remains open         |
| limit-1..limit-4                   | Partial | `agent-session-limits` continuation smoke     | Re-prompt lifecycle, event order, stale old prompt, unchanged budget   |
| auth-1..auth-3                     | Blocked | Interactive-connection fixture                | Nonblocking authorization scheduling and terminal lifecycle            |
| proxy-1                            | Partial | `agent-subagents-hitl` approval route         | Owner/projection lifecycle payload equality                            |
| proxy-2..proxy-6                   | Planned | `subagent-hitl-proxy` integration tier        | Route loss, closure races, responder identity, remote proof rejection  |
| cancellation-1                     | Planned | Integration tier                              | Per-turn request collection and deterministic active-turn cancellation |
| cancellation-2, cancellation-3     | Planned | Integration termination tier                  | Session-end and parent-projection closure ordering                     |
| cancellation-4                     | Planned | Integration forced-closure tier               | Proof that forced closure cannot restore a stored batch                |

Existing evals in `../hitl/` that assert the pre-contract behavior —
`text-approve`, `unrelated-message-queued`, `authored-always-unrelated-input`,
`stale-ask-question-selection*` — are superseded by these scenarios and retire
in the behavior stage.
