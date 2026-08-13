import { sleep } from "#compiled/@workflow/core/index.js";

import { refreshLocalSubagentWorkStep } from "#execution/refresh-local-subagent-work-step.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";

export const LOCAL_SUBAGENT_WORK_REFRESH_MS = 15_000;

export interface LocalSubagentWorkMonitorInput {
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: DurableSessionState;
}

/** Polls direct local subagent work without participating in parent turn control flow. */
export async function localSubagentWorkMonitorWorkflow(
  input: LocalSubagentWorkMonitorInput,
): Promise<void> {
  "use workflow";

  let serializedContext = input.serializedContext;
  while (true) {
    const refreshed = await refreshLocalSubagentWorkStep({
      serializedContext,
      sessionState: input.sessionState,
    });
    serializedContext = refreshed.serializedContext;
    if (!refreshed.hasRunningLocalSubagents) return;
    await sleep(LOCAL_SUBAGENT_WORK_REFRESH_MS);
  }
}
