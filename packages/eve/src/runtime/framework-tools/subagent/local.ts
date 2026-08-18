import { executeSubagentToolCall } from "#execution/tasks/parent/subagent/tool-execution.js";
import { defineTool } from "#public/definitions/tool.js";
import type { RuntimeSubagentCallActionRequest } from "#runtime/actions/types.js";
import { SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA } from "#runtime/framework-tools/tasks.js";
import { PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA } from "#runtime/subagents/registry.js";
import { parseJsonObject } from "#shared/json.js";

export function defineSubagent(input: {
  readonly description: string;
  readonly name: string;
  readonly nodeId: string;
}) {
  return defineTool({
    description: input.description,
    execute: (toolInput, ctx) =>
      executeSubagentToolCall({
        action: createAction(toolInput, ctx.callId, input),
      }),
    inputSchema: PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA,
    outputSchema: SUBAGENT_TASK_RECEIPT_OUTPUT_SCHEMA,
  });
}

function createAction(
  toolInput: unknown,
  callId: string,
  definition: { readonly description: string; readonly name: string; readonly nodeId: string },
): RuntimeSubagentCallActionRequest {
  return {
    callId,
    description: definition.description,
    input: parseJsonObject(PERSISTENT_SUBAGENT_TOOL_INPUT_SCHEMA.parse(toolInput)),
    kind: "subagent-call",
    name: definition.name,
    nodeId: definition.nodeId,
    subagentName: definition.name,
  };
}
