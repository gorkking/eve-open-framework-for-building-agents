import { satisfies } from "eve/evals/expect";

import { requireBackgroundTaskId, requireTaskView } from "./shared.js";
import { defineTaskEval } from "./task-transition.js";

export default defineTaskEval({
  description: "task_join holds the parent turn until a working background task becomes ready.",
  transition: {
    primary: "task.join.wait.observed-ready",
    setup: ["task.dispatch.start.accepted-acknowledged"],
    dimensions: { transport: "local", parentPhase: "active" },
  },
  async test(t) {
    const turn = await t.send("TASK-JOIN-WAIT");
    turn.expectOk();
    turn.messageIncludes("TASK-JOIN-COMPLETE");
    const taskId = requireBackgroundTaskId(turn);
    const joined = turn.requireToolCall("task_join", { input: { taskId } });
    const task = requireTaskView(joined.output, taskId);
    await t.require(
      task,
      satisfies(
        (view: Record<string, unknown>) =>
          view.status === "completed" && isResultOutput(view.lastOutput, "Return BUSY-WORKER-A."),
        "task_join returns the terminal child result",
      ),
    );
    turn.noFailedActions();
  },
});

function isResultOutput(value: unknown, expectedMarker: string): boolean {
  const data = value !== null && typeof value === "object" ? Reflect.get(value, "data") : undefined;
  return (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "type") === "result" &&
    typeof data === "string" &&
    data.startsWith("BUSY-WORKER:") &&
    data.includes(expectedMarker)
  );
}
