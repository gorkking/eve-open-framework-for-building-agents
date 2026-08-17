import { z } from "#compiled/zod/index.js";
import type {
  DispatchPlanEntry,
  DispatchStartTarget,
  RuntimeActionDispatchInput,
  RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import { dispatchSubagentWorkflowToolStep } from "#execution/tasks/parent/subagent/dispatch-step.js";
import type { ToolDefinition } from "#public/definitions/tool.js";
import { defineTool } from "#public/definitions/tool.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";

type ResumeEntry = Extract<DispatchPlanEntry, { readonly kind: "resume" }>;
type StartEntry = Extract<DispatchPlanEntry, { readonly kind: "start" }>;

export type LocalSubagentWorkflowEntry =
  | (Omit<ResumeEntry, "action" | "dynamicRemoteAgent"> & {
      readonly action: RuntimeSubagentCallActionRequest;
    })
  | (Omit<StartEntry, "target"> & {
      readonly target: Extract<DispatchStartTarget, { readonly kind: "local" }>;
    });

export type LocalSubagentWorkflowInput = z.infer<typeof PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA>;

export interface LocalSubagentWorkflowContext {
  readonly entry: LocalSubagentWorkflowEntry;
  readonly fanoutSize: number;
  readonly runtimeInput: RuntimeActionDispatchInput;
}

/** Runs one local subagent admission as an independently addressable Workflow. */
export async function executeLocalSubagentWorkflow(
  toolInput: LocalSubagentWorkflowInput,
  context: LocalSubagentWorkflowContext,
): Promise<RuntimeActionDispatchResult> {
  "use workflow";

  return await dispatchSubagentWorkflowToolStep({
    entry: context.entry,
    fanoutSize: context.fanoutSize,
    runtimeInput: context.runtimeInput,
    toolInput,
    transport: "local",
  });
}

export type LocalSubagentWorkflowTool = ToolDefinition<
  LocalSubagentWorkflowInput,
  RuntimeActionDispatchResult
>;

// Public tools receive a live ToolContext. This framework-owned Workflow is
// started by workflowId with a serializable private context.
export const localSubagentWorkflowTool: LocalSubagentWorkflowTool = defineTool({
  description: "Dispatch a local subagent as a durable background task.",
  execute: executeLocalSubagentWorkflow as LocalSubagentWorkflowTool["execute"] &
    typeof executeLocalSubagentWorkflow,
  inputSchema: PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA,
});

export function isLocalSubagentWorkflowEntry(
  entry: Extract<DispatchPlanEntry, { readonly kind: "resume" | "start" }>,
): entry is LocalSubagentWorkflowEntry {
  return entry.kind === "start"
    ? entry.target.kind === "local"
    : entry.action.kind === "subagent-call";
}
