/**
 * One durable poll tick over a turn's pending `task_join` calls.
 *
 * The turn workflow races its inbox against a short sleep while joins are
 * pending; each sleep tick runs this step. A join settles once its task's
 * view is ready — terminal or `input_required` (a terminal-only join would
 * deadlock against a task parked on human input) — producing a synthesized
 * `tool-result` whose key matches the originating `task_join` call.
 */

import { type DurableSessionState, readDurableSession } from "#execution/durable-session-store.js";
import { readTaskView } from "#execution/tasks/parent/control-shared.js";
import type { PendingTaskJoin } from "#execution/tasks/parent/dispatch.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";
import { TASK_JOIN_TOOL_NAME } from "#runtime/framework-tools/tasks.js";
import { taskViewsToJson } from "#tasks/json.js";
import { findSessionTaskEntry } from "#tasks/session-index.js";
import { isReadyTaskStatus } from "#tasks/types.js";

export async function pollJoinedTasksStep(input: {
  readonly joins: readonly PendingTaskJoin[];
  readonly sessionState: DurableSessionState;
}): Promise<readonly RuntimeActionResult[]> {
  "use step";

  const durable = await readDurableSession(input.sessionState);
  const settled: RuntimeActionResult[] = [];
  for (const join of input.joins) {
    // A vanished index entry keeps the join pending; turn cancellation is
    // the backstop (join timeout policy is out of scope).
    const entry = findSessionTaskEntry(durable.state, join.taskId);
    if (entry === undefined) continue;
    const view = await readTaskView(entry);
    if (!isReadyTaskStatus(view.status)) continue;
    settled.push({
      callId: join.callId,
      kind: "tool-result",
      output: taskViewsToJson([view]),
      toolName: TASK_JOIN_TOOL_NAME,
    });
  }
  return settled;
}
