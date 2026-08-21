import type { ContextContainer } from "#context/container.js";
import { ProgressCallbackKey, ProgressLineageKey } from "#context/keys.js";
import { projectActionProgressEvents } from "#execution/progress-action-events.js";
import { reportProgress } from "#execution/submit-progress.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import type { HarnessEmissionState } from "#harness/emission.js";
import type { MessageStreamEvent } from "#protocol/message.js";

export interface ProgressEventObserver {
  flush(): Promise<void>;
  observe(event: MessageStreamEvent): Promise<void>;
}

export function createProgressEventObserver(
  ctx: ContextContainer,
  emissionState: HarnessEmissionState,
  session: { readonly rootSessionId?: string; readonly sessionId: string },
): ProgressEventObserver | undefined {
  const callback = ctx.get(ProgressCallbackKey);
  if (callback === undefined) return undefined;
  const turnId = activeTurnId(emissionState);
  const lineage =
    ctx.get(ProgressLineageKey) ??
    (session.rootSessionId === undefined
      ? {
          id: `root:${session.sessionId}:${turnId}`,
          kind: "root-turn" as const,
          rootSessionId: session.sessionId,
          rootTurnId: turnId,
          sessionId: session.sessionId,
          turnId,
        }
      : undefined);
  if (lineage === undefined) return undefined;

  let started = false;
  const ensureStarted = async (at: string): Promise<void> => {
    if (started || lineage.kind !== "root-turn") return;
    started = true;
    await reportProgress({
      callback,
      events: [
        { eventId: `${lineage.id}:started`, kind: "work.started", startedAt: at, work: lineage },
      ],
    });
  };
  return {
    async flush() {
      if (!started) await ensureStarted(new Date().toISOString());
    },
    async observe(event) {
      await ensureStarted(event.meta.at);
      await reportProgress({
        callback,
        events: projectActionProgressEvents({ at: event.meta.at, event, lineage }),
      });
    },
  };
}
