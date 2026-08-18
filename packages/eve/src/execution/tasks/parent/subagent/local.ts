import type { z } from "#compiled/zod/index.js";
import type {
  DispatchPlanEntry,
  DispatchStartTarget,
  RuntimeActionDispatchInput,
  RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import { dispatchSubagentWorkflowToolStep } from "#execution/tasks/parent/subagent/dispatch-step.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import type { TASK_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";

type ResumeEntry = Extract<DispatchPlanEntry, { readonly kind: "resume" }>;
type StartEntry = Extract<DispatchPlanEntry, { readonly kind: "start" }>;

export type LocalSubagentWorkflowEntry =
  | (Omit<ResumeEntry, "action" | "dynamicRemoteAgent"> & {
      readonly action: RuntimeSubagentCallActionRequest;
    })
  | (Omit<StartEntry, "target"> & {
      readonly target: Extract<DispatchStartTarget, { readonly kind: "local" }>;
    });

export type LocalSubagentWorkflowInput = z.infer<typeof TASK_SUBAGENT_TOOL_INPUT_SCHEMA>;

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

export function isLocalSubagentWorkflowEntry(
  entry: Extract<DispatchPlanEntry, { readonly kind: "resume" | "start" }>,
): entry is LocalSubagentWorkflowEntry {
  return entry.kind === "start"
    ? entry.target.kind === "local"
    : entry.action.kind === "subagent-call";
}
