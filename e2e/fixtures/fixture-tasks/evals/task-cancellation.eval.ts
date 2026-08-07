import { defineEval } from "eve/evals";

import {
  requireBackgroundTaskId,
  sendAndFollowQueuedTurn,
  waitForTaskInput,
  waitForTaskStatus,
} from "./shared.js";

/**
 * Cancellation finality: `task_cancel` commits `cancelled` on a
 * nonterminal task, the snapshot stays readable, and repeating the
 * cancel is an idempotent no-op — a terminal state can never change.
 */
export default defineEval({
  description: "task_cancel commits a final cancelled state and repeated cancels are no-ops.",
  async test(t) {
    const started = await t.send("TASK-CANCEL-SETUP");
    started.expectOk();
    started.messageIncludes("TASK-CANCEL-READY");
    started.event("subagent.completed", {
      count: 1,
      data: { backgroundTask: { status: "working" }, subagentName: "fanout-worker" },
    });
    const taskId = requireBackgroundTaskId(started);

    // The worker blocks on its release gate, so the task is durably
    // nonterminal when the cancel lands.
    const blocked = await waitForTaskInput(t, t, "release");

    const cancelled = await sendAndFollowQueuedTurn(t, "TASK-CANCEL-NOW", blocked.session);
    cancelled.turn.expectOk();
    cancelled.turn.messageIncludes("TASK-CANCEL-DONE");
    cancelled.turn.calledTool("task_cancel", { input: { taskIds: [taskId] } });

    const verified = await waitForTaskStatus(
      t,
      cancelled.session,
      "TASK-CANCEL-VERIFY",
      taskId,
      "cancelled",
    );
    verified.expectOk();
    verified.messageIncludes("TASK-CANCEL-STATUS");

    // Cancelling an already-cancelled task changes nothing and is not an
    // error: the tool returns the same terminal view.
    const repeated = await sendAndFollowQueuedTurn(t, "TASK-CANCEL-NOW", cancelled.session);
    repeated.turn.expectOk();
    repeated.turn.messageIncludes("TASK-CANCEL-DONE");
    repeated.turn.calledTool("task_cancel", { input: { taskIds: [taskId] } });

    const still = await waitForTaskStatus(
      t,
      repeated.session,
      "TASK-CANCEL-VERIFY",
      taskId,
      "cancelled",
    );
    still.expectOk();
  },
});
