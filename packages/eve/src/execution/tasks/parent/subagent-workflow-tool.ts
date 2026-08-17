import type {
  DispatchPlanEntry,
  RuntimeActionDispatchInput,
  RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import { dispatchSubagentWorkflowToolStep } from "#execution/tasks/parent/subagent-workflow-tool-step.js";
import { defineTool, type ToolContext } from "#public/definitions/tool.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";
import { z } from "#compiled/zod/index.js";

export const SUBAGENT_WORKFLOW_TOOL_CONTEXT_KIND = "eve.subagent-workflow-tool";

export type SubagentWorkflowToolInput = z.infer<typeof PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA>;
export type SubagentWorkflowToolEntry = Extract<
  DispatchPlanEntry,
  { readonly kind: "resume" | "start" }
>;

/** Serializable framework context supplied when task mode starts the tool workflow. */
export interface SubagentWorkflowToolContext {
  readonly entry: SubagentWorkflowToolEntry;
  readonly fanoutSize: number;
  readonly kind: typeof SUBAGENT_WORKFLOW_TOOL_CONTEXT_KIND;
  readonly runtimeInput: RuntimeActionDispatchInput;
}

/**
 * Workflow executor shared by local and remote subagent definitions in task mode.
 * The first argument is the exact model-authored tool input; framework routing
 * state stays in the private second argument and never enters the model schema.
 */
export async function executeSubagentWorkflowTool(
  toolInput: SubagentWorkflowToolInput,
  context: ToolContext | SubagentWorkflowToolContext,
): Promise<RuntimeActionDispatchResult> {
  "use workflow";

  const invocation = readSubagentWorkflowToolContext(context);
  return await dispatchSubagentWorkflowToolStep({
    entry: invocation.entry,
    fanoutSize: invocation.fanoutSize,
    runtimeInput: invocation.runtimeInput,
    toolInput,
  });
}

/** Internal `defineTool` value whose executor is the task-mode dispatch workflow. */
export const subagentWorkflowTool = defineTool({
  description: "Dispatch a subagent as a durable background task.",
  execute: executeSubagentWorkflowTool,
  inputSchema: PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA,
});

function readSubagentWorkflowToolContext(
  value: ToolContext | SubagentWorkflowToolContext,
): SubagentWorkflowToolContext {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== SUBAGENT_WORKFLOW_TOOL_CONTEXT_KIND ||
    !("entry" in value) ||
    typeof value.entry !== "object" ||
    value.entry === null ||
    !("fanoutSize" in value) ||
    typeof value.fanoutSize !== "number" ||
    !("runtimeInput" in value) ||
    typeof value.runtimeInput !== "object" ||
    value.runtimeInput === null
  ) {
    throw new Error("Subagent workflow tool requires eve's private invocation context.");
  }
  return value as SubagentWorkflowToolContext;
}
