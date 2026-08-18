# Spike: per-call detach/join (tasks v1)

Builds on the concluded "subagents as Workflow tools" spike (this file's
previous content — see git history at `1095b2bc`): task-mode delegations
already start through Workflow-backed `defineTool` definitions and converge
on the durable task lifecycle.

Design: `research/tasks/tool-tasks-detach-join.md` in the shower repo
(decisions 1–6). Investigation: `tool-tasks-detach-join-investigation.md`
(floating-promise NO-GO; execution ownership is a dispatch-time property).

## Goal

Four behaviors:

1. **Per-call launch mode** — `background: boolean` on the subagent tool
   schema replaces the agent-global batch-level receipt behavior of
   `experimental.tasks`. Mixed batches (foreground + background in one turn)
   work. `experimental.tasks` remains the capability gate.
2. **`task_join`** — a turn blocks on an existing background task until it is
   ready (terminal or `input_required`); settles immediately if already
   ready. Deletes `task_sleep`'s reason to exist.
3. **Plain workflow-backed tool as a task** — a `defineTool` whose execute is
   a `"use workflow"` function gets a task record, a receipt, and joins.
4. **The v2 seam** — every answer to a pending call enters the turn's wait
   through one function, whether a child reported it or the framework wrote
   it itself (join results built from task views). v2's mid-flight detach
   flip is the same entry point fed a `{taskId, status: "working"}` receipt
   for a pending foreground call.

## Decisions recorded while landing

- Omitted `background` ⇒ foreground. This flips today's tasks-mode default
  (every delegation became a background task); receipts are now opt-in
  per call.
- Per-call mode governs **fresh starts only**: agentId continuations always
  take the task path, because session exclusivity (AGENT_BUSY) is enforced
  there and a foreground resume of a task-owned session would bypass it.
- Interrupt-sourced batches (dynamic workflow) carry no model arguments ⇒
  they default to foreground under tasks agents. Semantic change,
  spike-accepted.
- `fanoutSize` keeps counting background children toward the parent quota
  split.
- Joined task's own `:ready:` notification still replays as a user-visible
  delivery next turn (dedup is v2 territory).
- Join on a task whose run died pends until turn cancellation (timeout
  policy is v2).
- Carried residual from the prior spike: the Workflow `start()` inside a
  retryable step is a non-deduplicated side effect.

## Status

| Stage | What                                                    | Status  |
| ----- | ------------------------------------------------------- | ------- |
| 1     | `background` schema field (tasks variant), no behavior  | done    |
| 2     | per-call mode inside `dispatchTaskStep`, mixed batches  | done    |
| 3     | `task_join` front half (immediate settle / pendingJoin) | done    |
| 4     | join poll loop + synthesized settle (v2 seam)           | done    |
| 5     | plain workflow-backed tool as task (isolated seam)      | pending |
| 6     | closeout, full suites green                             | pending |

## Non-goals

Mid-flight flip of a pending call (v2 — the seam is built, unused for it),
timeout-driven detach and timers, the human "background this" command,
`:ready:` delivery dedup, `background` in arbitrary authored tool schemas,
parking plain tool calls from the model loop, eval anchors (`fixture-tasks`
lives on `rui/child-task-send`).
