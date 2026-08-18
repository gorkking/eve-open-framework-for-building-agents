import {
  dispatchTaskStep,
  type SubagentToolDispatchInput,
  type SubagentToolDispatchResult,
} from "#execution/tasks/parent/dispatch-task-step.js";

export { subagentWorkflowReference } from "#execution/tasks/parent/subagent/workflow-reference.js";

export async function executeSubagentWorkflow(
  input: SubagentToolDispatchInput,
): Promise<SubagentToolDispatchResult> {
  "use workflow";

  return dispatchTaskStep(input);
}
