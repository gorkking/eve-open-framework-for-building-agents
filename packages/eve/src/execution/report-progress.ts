import { loadContext } from "#context/container.js";
import { ProgressGroupKey, SessionKey } from "#context/keys.js";
import { submitProgressCommand } from "#execution/submit-progress.js";
import {
  normalizeProgressText,
  progressTurnId,
  type ProgressCommandV1,
} from "#execution/session-progress.js";

/** Queues a replace-in-place report owned by the current agent turn. */
export async function reportProgress(input: {
  readonly callId: string;
  readonly message: unknown;
}): Promise<{ readonly status: "queued" }> {
  const message = typeof input.message === "string" ? normalizeProgressText(input.message) : "";
  if (message === "") throw new Error("Provide a non-empty `message`.");

  const context = loadContext();
  const session = context.require(SessionKey);
  const now = new Date().toISOString();
  const id = `report:${session.sessionId}:${session.turn.id}:${input.callId}`;
  const command: ProgressCommandV1 = {
    commandId: id,
    events: [
      {
        eventId: id,
        kind: "report",
        report: { id: input.callId, message, reportedAt: now },
        turn: {
          groupId: context.get(ProgressGroupKey),
          id: progressTurnId(session.sessionId, session.turn.id),
          phase: "running",
          sequence: session.turn.sequence,
          startedAt: now,
        },
      },
    ],
    kind: "progress",
    version: 1,
  };

  await submitProgressCommand(context, command);
  return { status: "queued" };
}
