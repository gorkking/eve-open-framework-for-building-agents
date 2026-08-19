import { loadContext } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { sessionCommandHookToken } from "#execution/session-command-token.js";
import { normalizeProgressText, type ProgressCommandV1 } from "#execution/session-progress.js";
import { resumeHook } from "#internal/workflow/runtime.js";

/**
 * Queues an authored progress report on the root session's stable inbox.
 *
 * Local children already carry the root session id in framework-owned lineage,
 * so this deliberately derives the local route instead of persisting a target.
 */
export async function reportProgress(input: {
  readonly callId: string;
  readonly message: unknown;
}): Promise<{ readonly status: "queued" }> {
  const message = typeof input.message === "string" ? normalizeProgressText(input.message) : "";
  if (message === "") throw new Error("Provide a non-empty `message`.");

  const session = loadContext().require(SessionKey);
  const rootSessionId = session.parent?.rootSessionId ?? session.sessionId;
  const id = `report:${session.sessionId}:${session.turn.id}:${input.callId}`;
  const command: ProgressCommandV1 = {
    commandId: id,
    events: [
      {
        entityId: `agent:${session.sessionId}`,
        eventId: id,
        kind: "report",
        report: { id: input.callId, message, reportedAt: new Date().toISOString() },
        source: {
          depth: 0,
          id: `agent:${session.sessionId}`,
          kind: "subagent",
          label: "Working",
          name: "agent",
          parentId: session.parent === undefined ? undefined : `call:${session.parent.callId}`,
          phase: "running",
          turnId: session.turn.id,
        },
      },
    ],
    kind: "progress",
    version: 1,
  };
  await resumeHook(sessionCommandHookToken(rootSessionId), command);
  return { status: "queued" };
}
