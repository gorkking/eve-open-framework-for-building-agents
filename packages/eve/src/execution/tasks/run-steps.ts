import { getWritable } from "#compiled/@workflow/core/index.js";

import { TASK_SNAPSHOT_STREAM_NAMESPACE, type TaskView } from "#tasks/types.js";

/**
 * Appends one full task snapshot to the owning task run's `eve.task`
 * stream. Only the task run workflow calls this, which is what makes
 * the run the single writer readers can trust without re-validating.
 */
export async function appendTaskSnapshotStep(input: { readonly view: TaskView }): Promise<void> {
  "use step";

  const writable = getWritable<TaskView>({ namespace: TASK_SNAPSHOT_STREAM_NAMESPACE });
  const writer = writable.getWriter();
  try {
    await writer.write(input.view);
  } finally {
    writer.releaseLock();
  }
}
