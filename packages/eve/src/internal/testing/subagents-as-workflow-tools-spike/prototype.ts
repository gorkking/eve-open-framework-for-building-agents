import { createHook, getWritable } from "#compiled/@workflow/core/index.js";

import { defineTool, type ToolContext, type ToolDefinition } from "#public/definitions/tool.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

/**
 * Executable spike for lowering subagents to workflow-backed tools.
 *
 * This is deliberately internal and is not exported from eve. It proves the
 * representation and task-inbox protocol without claiming that model-call
 * dispatch has been switched to this path yet.
 */

export const PARENT_ENVELOPE_STREAM = "eve.spike.workflow-tool.parent";
export const CHILD_ENVELOPE_STREAM = "eve.spike.workflow-tool.child";

export interface SubagentToolInput {
  readonly agentId?: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
}

/**
 * The serializable data the dispatcher supplies when it starts the workflow.
 * It is intentionally not today's live ToolContext: capability methods,
 * AbortSignals, and runtime handles cannot cross Workflow's argument boundary.
 */
export interface WorkflowToolInvocationContext {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly toolName: string;
}

/** Existing subagent-task routing data, not a generic workflow-tool contract. */
export interface SubagentWorkflowInvocationContext extends WorkflowToolInvocationContext {
  readonly taskId: string;
  readonly taskInboxToken: string;
}

export interface WorkflowToolProbeInput {
  readonly value: string;
}

export interface WorkflowToolProbeOutput extends WorkflowToolInvocationContext {
  readonly value: string;
}

export type SubagentTaskInboxEnvelope =
  | {
      readonly kind: "task_post_message";
      readonly message: string;
      readonly mode: "queue" | "steer";
    }
  | {
      readonly kind: "input.required";
      readonly prompt: string;
      readonly requestId: string;
    }
  | {
      readonly kind: "input.response";
      readonly requestId: string;
      readonly value: JsonValue;
    }
  | { readonly kind: "output"; readonly value: JsonValue };

export type ParentTaskEnvelope =
  | {
      readonly callId: string;
      readonly kind: "task_post_message";
      readonly message: string;
      readonly mode: "queue" | "steer";
      readonly taskId: string;
    }
  | {
      readonly callId: string;
      readonly kind: "input.required";
      readonly prompt: string;
      readonly requestId: string;
      readonly taskId: string;
    };

export interface ChildInputEnvelope {
  readonly kind: "input.response";
  readonly requestId: string;
  readonly taskId: string;
  readonly value: JsonValue;
}

export interface LocalSubagentDefinition {
  readonly description: string;
  /** Compiled graph identity. Never model-authored input. */
  readonly nodeId: string;
}

export interface RemoteSubagentDefinition {
  readonly description: string;
  /** Compiled graph identity. Never model-authored input. */
  readonly nodeId: string;
  readonly url: string;
}

export type WorkflowSubagentTarget =
  | { readonly kind: "local"; readonly nodeId: string }
  | { readonly kind: "remote"; readonly nodeId: string; readonly url: string };

export const WORKFLOW_SUBAGENT_TARGET = Symbol.for("eve:spike:workflow-subagent-target");

export type WorkflowBackedSubagentTool = ToolDefinition<SubagentToolInput, JsonValue> & {
  readonly [WORKFLOW_SUBAGENT_TARGET]: WorkflowSubagentTarget;
};

const workflowToolProbeInputSchema = {
  additionalProperties: false,
  properties: { value: { type: "string" } },
  required: ["value"],
  type: "object",
} as const;

const subagentInputSchema = {
  additionalProperties: false,
  properties: {
    agentId: { type: "string" },
    message: { type: "string" },
    outputSchema: { type: "object" },
  },
  required: ["message"],
  type: "object",
} as const;

/** Ordinary workflow-backed tool used to prove this primitive is not agent-specific. */
export async function executeWorkflowToolProbe(
  input: WorkflowToolProbeInput,
  context: ToolContext,
): Promise<WorkflowToolProbeOutput> {
  "use workflow";

  return { ...readWorkflowToolInvocationContext(context), value: input.value };
}

export function defineWorkflowToolProbe(): ToolDefinition<
  WorkflowToolProbeInput,
  WorkflowToolProbeOutput
> {
  return defineTool({
    description: "Return the workflow-tool invocation descriptor",
    execute: executeWorkflowToolProbe,
    inputSchema: workflowToolProbeInputSchema,
  });
}

/** Framework-owned local subagent workflow used as defineTool.execute. */
export async function executeLocalSubagent(
  input: SubagentToolInput,
  context: ToolContext,
): Promise<JsonValue> {
  "use workflow";

  return await runSubagentTaskInbox(input, readSubagentWorkflowInvocationContext(context));
}

/** Framework-owned remote subagent workflow used as defineTool.execute. */
export async function executeRemoteSubagent(
  input: SubagentToolInput,
  context: ToolContext,
): Promise<JsonValue> {
  "use workflow";

  return await runSubagentTaskInbox(input, readSubagentWorkflowInvocationContext(context));
}

/**
 * Prototype public helper: the returned value is a real defineTool result;
 * the symbol metadata is framework-private dispatch identity.
 */
export function defineSubagent(definition: LocalSubagentDefinition): WorkflowBackedSubagentTool {
  return lowerSubagentToTool(definition.description, executeLocalSubagent, {
    kind: "local",
    nodeId: definition.nodeId,
  });
}

/** Remote counterpart with the same defineTool substrate. */
export function defineRemoteSubagent(
  definition: RemoteSubagentDefinition,
): WorkflowBackedSubagentTool {
  return lowerSubagentToTool(definition.description, executeRemoteSubagent, {
    kind: "remote",
    nodeId: definition.nodeId,
    url: definition.url,
  });
}

async function runSubagentTaskInbox(
  _input: SubagentToolInput,
  context: SubagentWorkflowInvocationContext,
): Promise<JsonValue> {
  const inbox = createHook<SubagentTaskInboxEnvelope>({ token: context.taskInboxToken });
  const iterator = inbox[Symbol.asyncIterator]();
  const outstandingInputRequests = new Set<string>();

  while (true) {
    const next = await iterator.next();
    if (next.done === true) {
      throw new Error(`Task inbox for "${context.taskId}" closed before canonical output.`);
    }

    const envelope = next.value;
    switch (envelope.kind) {
      case "task_post_message":
        await appendParentEnvelopeStep({
          callId: context.callId,
          kind: envelope.kind,
          message: envelope.message,
          mode: envelope.mode,
          taskId: context.taskId,
        });
        break;
      case "input.required":
        outstandingInputRequests.add(envelope.requestId);
        await appendParentEnvelopeStep({
          callId: context.callId,
          kind: envelope.kind,
          prompt: envelope.prompt,
          requestId: envelope.requestId,
          taskId: context.taskId,
        });
        break;
      case "input.response":
        if (!outstandingInputRequests.delete(envelope.requestId)) break;
        await appendChildEnvelopeStep({
          kind: envelope.kind,
          requestId: envelope.requestId,
          taskId: context.taskId,
          value: envelope.value,
        });
        break;
      case "output":
        // Canonical output is the workflow return value. It never travels as
        // task_post_message, even though both ultimately reach the parent.
        return envelope.value;
    }
  }
}

async function appendParentEnvelopeStep(envelope: ParentTaskEnvelope): Promise<void> {
  "use step";

  const writer = getWritable<ParentTaskEnvelope>({ namespace: PARENT_ENVELOPE_STREAM }).getWriter();
  try {
    await writer.write(envelope);
  } finally {
    writer.releaseLock();
  }
}

async function appendChildEnvelopeStep(envelope: ChildInputEnvelope): Promise<void> {
  "use step";

  const writer = getWritable<ChildInputEnvelope>({ namespace: CHILD_ENVELOPE_STREAM }).getWriter();
  try {
    await writer.write(envelope);
  } finally {
    writer.releaseLock();
  }
}

function lowerSubagentToTool(
  description: string,
  workflow: (input: SubagentToolInput, context: ToolContext) => Promise<JsonValue>,
  target: WorkflowSubagentTarget,
): WorkflowBackedSubagentTool {
  // The public ToolContext remains the plain-tool contract. Workflow-backed
  // dispatch does not call this function directly; it starts its workflowId
  // with the serializable WorkflowToolInvocationContext above.
  const tool = defineTool<SubagentToolInput, JsonValue>({
    description,
    execute: workflow,
    inputSchema: subagentInputSchema,
  });

  return Object.assign(tool, { [WORKFLOW_SUBAGENT_TARGET]: target });
}

function readWorkflowToolInvocationContext(context: ToolContext): WorkflowToolInvocationContext {
  if (!isRecord(context) || typeof context.parentSessionId !== "string") {
    throw new Error("Workflow tool dispatch requires a serializable parentSessionId.");
  }

  return {
    callId: context.callId,
    parentSessionId: context.parentSessionId,
    toolName: context.toolName,
  };
}

function readSubagentWorkflowInvocationContext(
  context: ToolContext,
): SubagentWorkflowInvocationContext {
  const base = readWorkflowToolInvocationContext(context);
  if (
    !isRecord(context) ||
    typeof context.taskId !== "string" ||
    typeof context.taskInboxToken !== "string"
  ) {
    throw new Error("Subagent workflow dispatch requires task identity and inbox routing.");
  }

  return {
    ...base,
    taskId: context.taskId,
    taskInboxToken: context.taskInboxToken,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
