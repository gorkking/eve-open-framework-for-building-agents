import { defineEval, type EveEvalToolCall } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import {
  requireBackgroundTaskId,
  sendAndFollowQueuedTurn,
  waitForCompletedTask,
} from "./shared.js";

/** Finding 05: one persistent child session admits at most one nonterminal task. */
export default defineEval({
  description:
    "Two same-batch task_send calls to one child admit one task and reject the other as AGENT_BUSY.",
  async test(t) {
    t.log("starting initial busy-worker task");
    const setup = await t.send("FINDING-05-SETUP");
    t.log("initial busy-worker task settled");
    setup.expectOk();
    setup.messageIncludes("FINDING-05-READY");
    const initialTaskId = requireBackgroundTaskId(setup);
    await waitForCompletedTask(t, t, "FINDING-05-VERIFY", initialTaskId);

    t.log("sending two same-batch continuations");
    const { turn: raced } = await sendAndFollowQueuedTurn(t, "FINDING-05-RACE");
    t.log("same-batch continuation turn settled");
    raced.expectOk();
    raced.messageIncludes("FINDING-05-RACE-DONE");

    const sends = raced.toolCalls.filter((call) => call.name === "task_send");
    await t.require(
      sends,
      satisfies((calls: readonly EveEvalToolCall[]) => {
        const admitted = calls.filter(
          (call) =>
            call.output !== null &&
            typeof call.output === "object" &&
            Reflect.get(call.output, "status") === "working",
        );
        const rejected = calls.filter((call) => JSON.stringify(call.output).includes("AGENT_BUSY"));
        return calls.length === 2 && admitted.length === 1 && rejected.length === 1;
      }, "exactly one same-batch task_send is admitted"),
    );
  },
});
