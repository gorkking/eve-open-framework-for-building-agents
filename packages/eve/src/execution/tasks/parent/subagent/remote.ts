import type {
  DispatchPlanEntry,
  DispatchStartTarget,
  RuntimeActionDispatchInput,
  RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import { dispatchSubagentWorkflowToolStep } from "#execution/tasks/parent/subagent/dispatch-step.js";
import {
  defineSubagentWorkflowTool,
  type SubagentWorkflowInput,
  type SubagentWorkflowTool,
} from "#execution/tasks/parent/subagent/workflow-tool.js";
import type { RuntimeRemoteAgentCallActionRequest } from "#runtime/actions/types.js";

type ResumeEntry = Extract<DispatchPlanEntry, { readonly kind: "resume" }>;
type StartEntry = Extract<DispatchPlanEntry, { readonly kind: "start" }>;

export type RemoteSubagentWorkflowEntry =
  | (Omit<ResumeEntry, "action"> & {
      readonly action: RuntimeRemoteAgentCallActionRequest;
    })
  | (Omit<StartEntry, "target"> & {
      readonly target: Extract<DispatchStartTarget, { readonly kind: "remote" }>;
    });

export type RemoteSubagentWorkflowInput = SubagentWorkflowInput;

export interface RemoteSubagentWorkflowContext {
  readonly entry: RemoteSubagentWorkflowEntry;
  readonly fanoutSize: number;
  readonly runtimeInput: RuntimeActionDispatchInput;
}

export type RemoteSubagentWorkflowTool = SubagentWorkflowTool<RemoteSubagentWorkflowContext>;

/** Runs one remote subagent admission as an independently addressable Workflow. */
export async function executeRemoteSubagentWorkflow(
  toolInput: RemoteSubagentWorkflowInput,
  context: RemoteSubagentWorkflowContext,
): Promise<RuntimeActionDispatchResult> {
  "use workflow";

  return await dispatchSubagentWorkflowToolStep({
    entry: context.entry,
    fanoutSize: context.fanoutSize,
    runtimeInput: context.runtimeInput,
    toolInput,
    transport: "remote",
  });
}

export const remoteSubagentWorkflowTool = defineSubagentWorkflowTool({
  description: "Dispatch a remote subagent as a durable background task.",
  execute: executeRemoteSubagentWorkflow,
});

export function isRemoteSubagentWorkflowEntry(
  entry: Extract<DispatchPlanEntry, { readonly kind: "resume" | "start" }>,
): entry is RemoteSubagentWorkflowEntry {
  return entry.kind === "start"
    ? entry.target.kind === "remote"
    : entry.action.kind === "remote-agent-call";
}
