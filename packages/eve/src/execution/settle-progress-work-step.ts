import { ProgressCallbackKey, ProgressLineageKey } from "#context/keys.js";
import { deserializeContext } from "#context/serialize.js";
import type { ProgressWorkPhase } from "#execution/session-progress.js";
import { reportProgress } from "#execution/submit-progress.js";

/** Best-effort settlement for one delegated work item. */
export async function settleProgressWorkStep(input: {
  readonly outcome: Exclude<ProgressWorkPhase, "running">;
  readonly serializedContext: Record<string, unknown>;
}): Promise<void> {
  "use step";

  const ctx = await deserializeContext(input.serializedContext);
  const work = ctx.get(ProgressLineageKey);
  if (work === undefined) return;
  await reportProgress({
    callback: ctx.get(ProgressCallbackKey),
    events: [
      {
        eventId: `${work.id}:settled:${input.outcome}`,
        kind: "work.settled",
        outcome: input.outcome,
        settledAt: new Date().toISOString(),
        workId: work.id,
      },
    ],
  });
}
