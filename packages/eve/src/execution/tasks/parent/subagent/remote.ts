import { z } from "#compiled/zod/index.js";
import type {
  DispatchPlanEntry,
  DispatchStartTarget,
  RuntimeActionDispatchInput,
  RuntimeActionDispatchResult,
} from "#execution/dispatch-runtime-actions-shared.js";
import { dispatchSubagentWorkflowToolStep } from "#execution/tasks/parent/subagent/dispatch-step.js";
import { defineTool, type ToolContext } from "#public/definitions/tool.js";
import type { RuntimeRemoteAgentCallActionRequest } from "#runtime/actions/types.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";

export const REMOTE_SUBAGENT_WORKFLOW_CONTEXT_KIND = "eve.subagent-workflow-tool.remote";

type ResumeEntry = Extract<DispatchPlanEntry, { readonly kind: "resume" }>;
type StartEntry = Extract<DispatchPlanEntry, { readonly kind: "start" }>;

export type RemoteSubagentWorkflowEntry =
  | (Omit<ResumeEntry, "action"> & {
      readonly action: RuntimeRemoteAgentCallActionRequest;
    })
  | (Omit<StartEntry, "target"> & {
      readonly target: Extract<DispatchStartTarget, { readonly kind: "remote" }>;
    });

export type RemoteSubagentWorkflowInput = z.infer<typeof PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA>;

export interface RemoteSubagentWorkflowContext {
  readonly entry: RemoteSubagentWorkflowEntry;
  readonly fanoutSize: number;
  readonly kind: typeof REMOTE_SUBAGENT_WORKFLOW_CONTEXT_KIND;
  readonly runtimeInput: RuntimeActionDispatchInput;
}

/** Runs one remote subagent admission as an independently addressable Workflow. */
export async function executeRemoteSubagentWorkflow(
  toolInput: RemoteSubagentWorkflowInput,
  context: ToolContext | RemoteSubagentWorkflowContext,
): Promise<RuntimeActionDispatchResult> {
  "use workflow";

  const invocation = readRemoteSubagentWorkflowContext(context);
  return await dispatchSubagentWorkflowToolStep({
    entry: invocation.entry,
    fanoutSize: invocation.fanoutSize,
    runtimeInput: invocation.runtimeInput,
    toolInput,
    transport: "remote",
  });
}

export const remoteSubagentWorkflowTool = defineTool({
  description: "Dispatch a remote subagent as a durable background task.",
  execute: executeRemoteSubagentWorkflow,
  inputSchema: PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA,
});

export function isRemoteSubagentWorkflowEntry(
  entry: Extract<DispatchPlanEntry, { readonly kind: "resume" | "start" }>,
): entry is RemoteSubagentWorkflowEntry {
  return entry.kind === "start"
    ? entry.target.kind === "remote"
    : entry.action.kind === "remote-agent-call";
}

function readRemoteSubagentWorkflowContext(
  value: ToolContext | RemoteSubagentWorkflowContext,
): RemoteSubagentWorkflowContext {
  if (
    typeof value !== "object" ||
    value === null ||
    !("kind" in value) ||
    value.kind !== REMOTE_SUBAGENT_WORKFLOW_CONTEXT_KIND ||
    !("entry" in value) ||
    typeof value.entry !== "object" ||
    value.entry === null ||
    !("fanoutSize" in value) ||
    typeof value.fanoutSize !== "number" ||
    !("runtimeInput" in value) ||
    typeof value.runtimeInput !== "object" ||
    value.runtimeInput === null
  ) {
    throw new Error("Remote subagent workflow requires eve's private invocation context.");
  }
  return value as RemoteSubagentWorkflowContext;
}
