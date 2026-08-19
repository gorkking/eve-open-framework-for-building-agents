import type { FlexibleSchema } from "ai";

import type { Approval } from "#public/definitions/approval.js";
import type { ToolExecuteOptions } from "#shared/tool-definition.js";

/**
 * Runtime-owned action metadata attached to one harness-visible tool.
 *
 * These tools are surfaced to the model without a local `execute` function.
 * The harness records the tool call and the runtime executes it later.
 *
 * `task-control` marks the `experimental.tasks` parent tools
 * (`task_cancel`, `task_update`): they carry no child
 * address of their own — the dispatch step resolves targets through the
 * session task index by tool name.
 */
export type HarnessRuntimeActionDefinition =
  | {
      readonly kind: "remote-agent-call" | "subagent-call";
      readonly nodeId: string;
      readonly remoteAgentName?: string;
      readonly subagentName: string;
    }
  | { readonly kind: "task-control" };

export type HarnessDelegationAction = Exclude<
  HarnessRuntimeActionDefinition,
  { readonly kind: "task-control" }
>;

type HarnessToolExecute = (input: any, options: ToolExecuteOptions) => any;

interface HarnessToolBase {
  readonly approvalKey?: (toolInput: Readonly<Record<string, unknown>>) => string;
  readonly description: string;
  readonly inputSchema: FlexibleSchema;
  readonly name: string;
  readonly approval?: Approval;
  readonly outputSchema?: FlexibleSchema;
  readonly toModelOutput?: (output: unknown) => unknown;
}

/** Harness-visible tool. Delegation routing has one discriminated owner. */
export type HarnessToolDefinition = HarnessToolBase &
  (
    | {
        readonly delegation?: never;
        readonly execute?: HarnessToolExecute;
        readonly frameworkAction?: "load-skill";
        readonly runtimeAction?: Extract<
          HarnessRuntimeActionDefinition,
          { readonly kind: "task-control" }
        >;
      }
    | {
        readonly delegation: {
          readonly action: HarnessDelegationAction;
          readonly execution: "ai-sdk";
          readonly rootOnly?: boolean;
        };
        readonly execute: HarnessToolExecute;
        readonly frameworkAction?: never;
        readonly runtimeAction?: never;
      }
    | {
        readonly delegation: {
          readonly action: HarnessDelegationAction;
          readonly execution: "runtime-action";
          readonly rootOnly?: boolean;
        };
        readonly execute?: never;
        readonly frameworkAction?: never;
        readonly runtimeAction?: never;
      }
  );

export function getHarnessDelegationAction(
  definition: HarnessToolDefinition | undefined,
): HarnessDelegationAction | undefined {
  return definition?.delegation?.action;
}

export function getHarnessRuntimeAction(
  definition: HarnessToolDefinition | undefined,
): HarnessRuntimeActionDefinition | undefined {
  return definition?.delegation?.execution === "runtime-action"
    ? definition.delegation.action
    : definition?.runtimeAction;
}

export function isAiSdkDelegationTool(definition: HarnessToolDefinition | undefined): boolean {
  return definition?.delegation?.execution === "ai-sdk";
}
