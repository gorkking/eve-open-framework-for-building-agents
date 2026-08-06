import type { EveEvalContext, EveEvalSession, EveEvalTurn, InputRequest } from "eve/evals";
import { satisfies } from "eve/evals/expect";

type SessionDriver = Pick<
  EveEvalSession,
  "pendingInputRequests" | "respond" | "send" | "sessionId" | "state"
>;

export interface PendingTaskInput {
  readonly request: InputRequest;
  readonly session: SessionDriver;
}

/** Waits across server-initiated parent turns for one task-owned input request. */
export async function waitForTaskInput(
  t: EveEvalContext,
  initialSession: SessionDriver,
  toolName: string,
): Promise<PendingTaskInput> {
  let session = initialSession;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const pending = session.pendingInputRequests.find(
      (request) => request.action.toolName === toolName,
    );
    if (pending !== undefined) return { request: pending, session };

    const sessionId = session.sessionId;
    if (sessionId === undefined) throw new Error("Task input wait has no parent session id.");
    const live = t.target.watchTurn(sessionId, { startIndex: session.state.streamIndex });
    await live.result();
    session = live.session;
  }
  throw new Error(`Task did not surface input for tool "${toolName}" after five turns.`);
}

/** Reads the task receipt attached to a background `subagent.completed` event. */
export function requireBackgroundTaskId(turn: EveEvalTurn): string {
  for (const event of turn.events) {
    if (event.type === "subagent.completed" && event.data.backgroundTask !== undefined) {
      return event.data.backgroundTask.taskId;
    }
  }
  throw new Error("Turn completed without a background task receipt.");
}

/** Polls the non-blocking task view until the expected task is completed. */
export async function waitForCompletedTask(
  t: EveEvalContext,
  session: SessionDriver,
  verificationMessage: string,
  taskId: string,
): Promise<EveEvalTurn> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const turn = await session.send(`${verificationMessage} ${taskId}`);
    const peeked = turn.toolCalls.find((call) => call.name === "task_peek");
    if (taskStatus(peeked?.output, taskId) === "completed") {
      await t.require(
        peeked?.output,
        satisfies(
          (output) => taskStatus(output, taskId) === "completed",
          `task_peek returns completed task ${taskId}`,
        ),
      );
      return turn;
    }
    await t.sleep(100);
  }
  throw new Error(`Task ${taskId} did not complete after 20 task_peek attempts.`);
}

function taskStatus(output: unknown, taskId: string): unknown {
  if (output === null || typeof output !== "object") return undefined;
  const tasks = Reflect.get(output, "tasks");
  if (!Array.isArray(tasks)) return undefined;
  const task = tasks.find(
    (candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      Reflect.get(candidate, "taskId") === taskId,
  );
  return task === undefined ? undefined : Reflect.get(task, "status");
}
