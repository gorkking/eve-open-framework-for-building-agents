import { z } from "#compiled/zod/index.js";
import type {
  DispatchPlanEntry,
  DispatchStartTarget,
  RuntimeActionDispatchInput,
  RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import { dispatchSubagentWorkflowToolStep } from "#execution/tasks/parent/subagent/dispatch-step.js";
import { defineTool, type ToolContext } from "#public/definitions/tool.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";

export const LOCAL_SUBAGENT_WORKFLOW_CONTEXT_KIND = "eve.subagent-workflow-tool.local";

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
  readonly kind: typeof LOCAL_SUBAGENT_WORKFLOW_CONTEXT_KIND;
  readonly runtimeInput: RuntimeActionDispatchInput;
}

/** Runs one local subagent admission as an independently addressable Workflow. */
export async function executeLocalSubagentWorkflow(
  toolInput: LocalSubagentWorkflowInput,
  context: ToolContext | LocalSubagentWorkflowContext,
): Promise<RuntimeActionDispatchResult> {
  "use workflow";

  const invocation = readLocalSubagentWorkflowContext(context);
  return await dispatchSubagentWorkflowToolStep({
    entry: invocation.entry,
    fanoutSize: invocation.fanoutSize,
    runtimeInput: invocation.runtimeInput,
    toolInput,
    transport: "local",
  });
}

export const localSubagentWorkflowTool = defineTool({
  description: "Dispatch a local subagent as a durable background task.",
  execute: executeLocalSubagentWorkflow,
  inputSchema: PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA,
});

export function isLocalSubagentWorkflowEntry(
  entry: Extract<DispatchPlanEntry, { readonly kind: "resume" | "start" }>,
): entry is LocalSubagentWorkflowEntry {
  return entry.kind === "start"
    ? entry.target.kind === "local"
    : entry.action.kind === "subagent-call";
}

function readLocalSubagentWorkflowContext(
  value: ToolContext | LocalSubagentWorkflowContext,
): LocalSubagentWorkflowContext {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== LOCAL_SUBAGENT_WORKFLOW_CONTEXT_KIND ||
    !("entry" in value) ||
    typeof value.entry !== "object" ||
    value.entry === null ||
    !("fanoutSize" in value) ||
    typeof value.fanoutSize !== "number" ||
    !("runtimeInput" in value) ||
    typeof value.runtimeInput !== "object" ||
    value.runtimeInput === null
  ) {
    throw new Error("Local subagent workflow requires eve's private invocation context.");
  }
  return value as LocalSubagentWorkflowContext;
}
