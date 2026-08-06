# HITL lifecycle scenario coverage

Executable form of the normative scenarios in
`research/hitl-request-lifecycle.md`. Evals here are gated by
`EVE_HITL_LIFECYCLE_CONTRACT=1` and skip until the behavior and
lifecycle-event stages land. Scenario IDs not covered by this fixture name
their tier or blocking dependency instead — one owner per ID, no duplicates.

| Scenario         | Coverage                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ |
| AP-1             | `ap-1-structured-approve.eval.ts`                                                                                        |
| AP-2, AP-3, AP-5 | Blocked: two-principal channel (multiplayer stage fixture)                                                               |
| AP-4, AP-8       | `ap-4-ap-8-message-then-late-approve.eval.ts`                                                                            |
| AP-6             | `ap-6-plain-text-is-a-message.eval.ts`                                                                                   |
| AP-7             | `ap-7-response-and-message-together.eval.ts`                                                                             |
| AP-7B            | Unit tier: partial-batch compound delivery (`input-requests.test.ts`)                                                    |
| AP-9, AP-14      | `ap-9-ap-14-stale-and-duplicate.eval.ts`                                                                                 |
| AP-10            | `ap-10-stale-response-with-message.eval.ts`                                                                              |
| AP-11, AP-12     | Blocked: Cancel decision (PR #1368)                                                                                      |
| AP-13            | Blocked: two-principal channel + PR #1368                                                                                |
| AP-15, AP-15B    | Unit tier: policy failure and invalid values are deterministic resolver cases                                            |
| AP-16, AP-17     | Blocked: authorization-required candidates (PR #1368)                                                                    |
| Q-1              | Covered today by `../hitl/ask-question-select.eval.ts`; contract adds `input.responded(answered)` in the lifecycle stage |
| Q-2              | `q-2-message-supersedes-question.eval.ts`                                                                                |
| Q-3              | Blocked: two-principal channel                                                                                           |
| Q-4              | `q-4-answer-and-message-together.eval.ts`                                                                                |
| B-1, B-2         | `b-1-b-2-mixed-batch-partial-then-close.eval.ts`                                                                         |
| B-3              | Integration tier: forced closure must not restore batches (cancellation paths)                                           |
| B-4              | `b-4-second-batch-while-first-open.eval.ts`                                                                              |
| B-5              | Unit tier: mixed-batch supersession ordering                                                                             |
| T-1              | Integration tier: arrival-order race against request creation                                                            |
| T-2, T-3         | Blocked: two-principal channel                                                                                           |
| SL-1..SL-4       | `agent-session-limits` fixture (re-prompt, Continue, Stop, stale)                                                        |
| AU-1..AU-3       | Blocked: interactive-connection fixture + nonblocking authorization scheduling                                           |
| P-1..P-6         | `agent-subagents-hitl` fixture + `subagent-hitl-proxy` integration tests                                                 |
| L-1, L-2         | Integration tier: fail-closed creation (tool-loop runtime-action and metadata paths)                                     |
| L-3..L-5         | Integration tier: cancellation and termination closure ordering                                                          |

Existing evals in `../hitl/` that assert the pre-contract behavior —
`text-approve`, `unrelated-message-queued`, `authored-always-unrelated-input`,
`stale-ask-question-selection*` — are superseded by these scenarios and retire
in the behavior stage.
