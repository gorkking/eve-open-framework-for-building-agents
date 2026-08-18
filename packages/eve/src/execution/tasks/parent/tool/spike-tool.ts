/**
 * Spike fixture: a plain (non-subagent) tool whose execute is a compiled
 * `"use workflow"` function, provable as a task through
 * `dispatchToolTask`.
 *
 * Workflow-body module: no zod, no `defineTool` — the branded wrapper
 * lives in `spike-tool-definition.ts` so definition-time code stays out
 * of the compiled Workflow program.
 */

export interface SpikeToolTaskInput {
  readonly background?: boolean;
  readonly echo: string;
}

export async function executeSpikeToolTaskWorkflow(
  input: SpikeToolTaskInput,
): Promise<{ readonly echoed: string }> {
  "use workflow";

  return { echoed: `spike-tool:${input.echo}` };
}
