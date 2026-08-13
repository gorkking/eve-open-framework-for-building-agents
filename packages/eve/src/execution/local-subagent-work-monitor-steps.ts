import {
  localSubagentWorkMonitorWorkflowReference,
  startWorkflowPreferLatest,
} from "#execution/workflow-runtime.js";
import type { LocalSubagentWorkMonitorInput } from "#execution/local-subagent-work-monitor-workflow.js";

/** Starts the sibling workflow that polls local child work for channel rendering. */
export async function startLocalSubagentWorkMonitorStep(
  input: LocalSubagentWorkMonitorInput,
): Promise<void> {
  "use step";

  await startWorkflowPreferLatest(localSubagentWorkMonitorWorkflowReference, [input]);
}
