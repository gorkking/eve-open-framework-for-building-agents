import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import { createToolExecuteWithAuth } from "#execution/tool-auth.js";
import { defineSubagent } from "#runtime/framework-tools/subagent/local.js";
import { defineRemoteSubagent } from "#runtime/framework-tools/subagent/remote.js";
import type { PreparedRuntimeDelegationTool } from "#runtime/sessions/turn.js";
import { UNSPECIFIED_INPUT_SCHEMA, toInputSchema, toOutputSchema } from "#shared/tool-schema.js";

export function createHarnessDelegationToolDefinition(
  tool: PreparedRuntimeDelegationTool,
): HarnessToolDefinition {
  const runtimeAction: HarnessToolDefinition["runtimeAction"] =
    tool.kind === "remote"
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

  return {
    description: tool.description ?? "",
    inputSchema: toInputSchema(tool.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(tool.outputSchema),
    runtimeAction,
  };
}

export function createTaskSubagentHarnessDefinition(
  tool: Pick<PreparedRuntimeDelegationTool, "description" | "kind" | "name" | "nodeId"> & {
    readonly rootOnly?: boolean;
  },
): HarnessToolDefinition {
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
    description: definition.description,
    execute: createToolExecuteWithAuth({
      execute: definition.execute,
      scope: tool.name,
    }),
    frameworkAction: "subagent",
    inputSchema: toInputSchema(definition.inputSchema) ?? UNSPECIFIED_INPUT_SCHEMA,
    name: tool.name,
    outputSchema: toOutputSchema(definition.outputSchema),
    rootOnly: tool.rootOnly,
  };
}
