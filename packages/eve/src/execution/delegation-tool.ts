import type { HarnessDelegationAction, HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { defineSubagent } from "#runtime/framework-tools/subagent/local.js";
import { defineRemoteSubagent } from "#runtime/framework-tools/subagent/remote.js";
import type { PreparedRuntimeDelegationTool } from "#runtime/sessions/turn.js";
import {
  UNSPECIFIED_INPUT_SCHEMA,
  toInputSchema,
  toOutputSchema,
  type ToolSchemaSource,
} from "#shared/tool-schema.js";

type HarnessDelegationTool = Pick<
  PreparedRuntimeDelegationTool,
  "description" | "kind" | "name" | "nodeId"
> & {
  readonly inputSchema?: ToolSchemaSource | null;
  readonly outputSchema?: ToolSchemaSource | null;
  readonly rootOnly?: boolean;
};

export function createHarnessDelegationToolDefinition(
  tool: HarnessDelegationTool,
): HarnessToolDefinition {
  const action = createDelegationAction(tool);

  return {
    delegation: { action, execution: "runtime-action", rootOnly: tool.rootOnly },
    description: tool.description ?? "",
    inputSchema: toInputSchema(tool.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(tool.outputSchema) ?? undefined,
  };
}

export function createTaskSubagentHarnessDefinition(
  tool: HarnessDelegationTool,
): HarnessToolDefinition {
  const action = createDelegationAction(tool);
  const definition =
    tool.kind === "remote"
      ? defineRemoteSubagent({
          description: tool.description ?? "",
          name: tool.name,
          nodeId: tool.nodeId,
        })
      : defineSubagent({
          description: tool.description ?? "",
          name: tool.name,
          nodeId: tool.nodeId,
        });

  return {
    delegation: { action, execution: "ai-sdk", rootOnly: tool.rootOnly },
    description: definition.description,
    execute: createToolExecuteWithAuth({
      execute: definition.execute,
      scope: tool.name,
    }),
    inputSchema: toInputSchema(definition.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(definition.outputSchema),
  };
}

function createDelegationAction(
  tool: Pick<PreparedRuntimeDelegationTool, "kind" | "name" | "nodeId">,
): HarnessDelegationAction {
  return tool.kind === "remote"
    ? {
        kind: "remote-agent-call",
        nodeId: tool.nodeId,
        remoteAgentName: tool.name,
        subagentName: tool.name,
      }
    : {
        kind: "subagent-call",
        nodeId: tool.nodeId,
        subagentName: tool.name,
      };
}
