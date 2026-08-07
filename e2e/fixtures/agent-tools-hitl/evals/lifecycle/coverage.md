# HITL lifecycle scenario coverage

Executable form of the normative scenarios in
`research/hitl-request-lifecycle.md`. Evals here are gated by
`EVE_HITL_LIFECYCLE_CONTRACT=1` and skip until the behavior and
lifecycle-event stages land. Scenario IDs not covered by this fixture name
their tier or blocking dependency instead — one owner per ID, no duplicates.

Families: `approval` (human consent for a tool call, including batch, timing,
and creation mechanics), `question` (`ask_question`), `limit` (session-limit
prompts), `auth` (connection authorization — OAuth credentials, not consent),
`proxy` (child-owned requests routed through parents), `cancellation` (turn
and session closure).

| Scenario                           | Coverage                                                                                                                 |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| approval-1                         | `approval-1-structured-approve.eval.ts`                                                                                  |
| approval-2, approval-3, approval-5 | Blocked: two-principal channel (multiplayer stage fixture)                                                               |
| approval-4, approval-8             | `approval-4-approval-8-message-then-late-approve.eval.ts`                                                                |
| approval-6                         | `approval-6-plain-text-is-a-message.eval.ts`                                                                             |
| approval-7                         | `approval-7-response-and-message-together.eval.ts`                                                                       |
| approval-7b                        | Unit tier: partial-batch compound delivery (`input-requests.test.ts`)                                                    |
| approval-9, approval-14            | `approval-9-approval-14-stale-and-duplicate.eval.ts`                                                                     |
| approval-10                        | `approval-10-stale-response-with-message.eval.ts`                                                                        |
| approval-11, approval-12           | Blocked: Cancel decision (PR #1368)                                                                                      |
| approval-13                        | Blocked: two-principal channel + PR #1368                                                                                |
| approval-15, approval-15b          | Unit tier: policy failure and invalid values are deterministic resolver cases                                            |
| approval-16, approval-17           | Blocked: authorization-required candidates (PR #1368)                                                                    |
| approval-18, approval-19           | `approval-18-approval-19-mixed-batch-partial-then-close.eval.ts`                                                         |
| approval-20                        | `approval-20-second-batch-while-first-open.eval.ts`                                                                      |
| approval-21                        | Integration tier: arrival-order race against request creation                                                            |
| approval-22, approval-23           | Blocked: two-principal channel                                                                                           |
| approval-24, approval-25           | Integration tier: fail-closed creation (tool-loop runtime-action and metadata paths)                                     |
| question-1                         | Covered today by `../hitl/ask-question-select.eval.ts`; contract adds `input.responded(answered)` in the lifecycle stage |
| question-2                         | `question-2-message-supersedes-question.eval.ts`                                                                         |
| question-3                         | Blocked: two-principal channel                                                                                           |
| question-4                         | `question-4-answer-and-message-together.eval.ts`                                                                         |
| question-5                         | Unit tier: mixed-batch supersession ordering                                                                             |
| limit-1..limit-4                   | `agent-session-limits` fixture (re-prompt, Continue, Stop, stale)                                                        |
| auth-1..auth-3                     | Blocked: interactive-connection fixture + nonblocking authorization scheduling                                           |
| proxy-1..proxy-6                   | `agent-subagents-hitl` fixture + `subagent-hitl-proxy` integration tests                                                 |
| cancellation-1                     | `cancellation-1-turn-cancel-dismisses-requests.eval.ts`                                                                  |
| cancellation-2, cancellation-3     | Integration tier: session-end and parent-termination closure ordering                                                    |
| cancellation-4                     | Integration tier: forced closure must not restore batches                                                                |

Existing evals in `../hitl/` that assert the pre-contract behavior —
`text-approve`, `unrelated-message-queued`, `authored-always-unrelated-input`,
`stale-ask-question-selection*` — are superseded by these scenarios and retire
in the behavior stage.
