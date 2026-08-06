import { defineEval, type EveEvalContext, type EveEvalToolCall, type EveEvalTurn } from "eve/evals";
import { satisfies } from "eve/evals/expect";

import { requireBackgroundTaskId, waitForCompletedTask } from "./shared.js";

/** One persistent child session admits at most one nonterminal task. */
export default defineEval({
  description:
    "Two same-batch task_send calls to one child admit one task and reject the other as AGENT_BUSY.",
  async test(t) {
    t.log("starting initial busy-worker task");
    const setup = await t.send("CHILD-TASK-EXCLUSIVITY-SETUP");
    t.log("initial busy-worker task settled");
    setup.expectOk();
    setup.messageIncludes("CHILD-TASK-EXCLUSIVITY-READY");
    const initialTaskId = requireBackgroundTaskId(setup);
    await waitForCompletedTask(t, t, "CHILD-TASK-EXCLUSIVITY-VERIFY", initialTaskId);

    t.log("sending two same-batch continuations");
    const raced = await sendAndFollowQueuedTurn(t, "CHILD-TASK-EXCLUSIVITY-RACE");
    t.log("same-batch continuation turn settled");
    raced.expectOk();
    raced.messageIncludes("CHILD-TASK-EXCLUSIVITY-RACE-DONE");

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

async function sendAndFollowQueuedTurn(t: EveEvalContext, message: string): Promise<EveEvalTurn> {
  let turn = await t.send(message);
  let startIndex = t.state.streamIndex;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const received = turn.events.some(
      (event) => event.type === "message.received" && event.data.message === message,
    );
    if (received) return turn;

    const sessionId = t.sessionId;
    if (sessionId === undefined) throw new Error("Queued turn follow-up has no session id.");
    const live = t.target.watchTurn(sessionId, { startIndex });
    turn = await live.result();
    startIndex = live.session.state.streamIndex;
  }
  throw new Error(`Queued message "${message}" was not received after five turns.`);
}
