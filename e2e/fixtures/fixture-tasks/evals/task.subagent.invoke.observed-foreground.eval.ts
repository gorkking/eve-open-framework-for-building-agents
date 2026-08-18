import { satisfies } from "eve/evals/expect";

import { defineTaskEval } from "./task-transition.js";

const CHILD_OUTPUT = /BUSY-WORKER:[\s\S]*TASK-FOREGROUND-CHILD/u;

export default defineTaskEval({
  description:
    "A fresh subagent call without background:true returns the child result and creates no task receipt.",
  transition: {
    primary: "task.subagent.invoke.observed-foreground",
    dimensions: { transport: "local", parentPhase: "active" },
  },
  async test(t) {
    const turn = await t.send("TASK-FOREGROUND-DEFAULT");
    turn.expectOk();
    turn.messageIncludes("TASK-FOREGROUND-COMPLETE");
    turn.calledSubagent("busy-worker", { count: 1, output: CHILD_OUTPUT, status: "completed" });
    await t.require(
      turn.events,
      satisfies(
        (events: typeof turn.events) =>
          !events.some(
            (event) =>
              event.type === "subagent.completed" && event.data.backgroundTask !== undefined,
          ),
        "foreground call emits no background task receipt",
      ),
    );
    turn.noFailedActions();
  },
});
