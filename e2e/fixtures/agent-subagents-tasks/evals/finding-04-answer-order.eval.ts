import { defineEval } from "eve/evals";

import { requireBackgroundTaskId, waitForCompletedTask, waitForTaskInput } from "./shared.js";

/**
 * Finding 04: replaying Q1 after the child has raised Q2 must neither deliver
 * Q1 again nor clear Q2 from the task snapshot.
 */
export default defineEval({
  description: "A stale task answer cannot unblock or erase the child's newer approval request.",
  async test(t) {
    const started = await t.send("FINDING-04-STALE-ANSWER");
    started.expectOk();
    const taskId = requireBackgroundTaskId(started);

    const first = await waitForTaskInput(t, t, "first_gate");
    const firstAnswer = await first.session.respond({
      optionId: "approve",
      requestId: first.request.requestId,
    });
    firstAnswer.expectOk();

    const second = await waitForTaskInput(t, first.session, "second_gate");
    const stale = await second.session.respond({
      optionId: "approve",
      requestId: first.request.requestId,
    });
    stale.expectOk();

    // If the stale Q1 answer cleared Q2, this exact Q2 response cannot resume
    // the child and the task never reaches `completed`.
    const secondAnswer = await second.session.respond({
      optionId: "approve",
      requestId: second.request.requestId,
    });
    secondAnswer.expectOk();

    const verified = await waitForCompletedTask(t, second.session, "FINDING-04-VERIFY", taskId);
    verified.expectOk();
    verified.messageIncludes("FINDING-04-STATUS");
    t.noFailedActions();
  },
});
