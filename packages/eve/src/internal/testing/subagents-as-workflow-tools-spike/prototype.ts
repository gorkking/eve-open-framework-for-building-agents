import { createHook, getWritable } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, closeHookIterator, disposeHook } from "#execution/hook-ownership.js";
import { resumeHook } from "#internal/workflow/runtime.js";
import { defineTool, type ToolContext, type ToolDefinition } from "#public/definitions/tool.js";
import type { JsonObject, JsonValue } from "#shared/json.js";

/**
 * Executable, test-only spike for lowering subagents to workflow-backed tools.
 *
 * The prototype deliberately owns its dispatcher, hook protocol, and executor
 * workflows. It does not call or claim compatibility with eve's production
 * task or subagent dispatch paths.
 */

export const PROTOTYPE_TRANSCRIPT_STREAM = "eve.spike.workflow-tool.transcript";

export interface SubagentToolInput {
  readonly agentId?: string;
  readonly message: string;
  readonly outputSchema?: JsonObject;
}

/** Serializable context supplied by the prototype dispatcher. */
export interface WorkflowToolInvocationContext {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly toolName: string;
}

export interface SubagentWorkflowInvocationContext extends WorkflowToolInvocationContext {
  readonly subagentInboxToken: string;
  readonly target: WorkflowSubagentTarget;
  readonly workflowInboxToken: string;
}

export interface WorkflowToolProbeInput {
  readonly value: string;
}

export interface WorkflowToolProbeOutput extends WorkflowToolInvocationContext {
  readonly value: string;
}

export type PrototypeSubagentEnvelope =
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

export interface PrototypeTranscriptEntry {
  readonly callId: string;
  readonly direction: "child-to-parent" | "parent-to-child";
  readonly envelope: PrototypeSubagentEnvelope;
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

export type WorkflowBackedTool<TInput, TWorkflowContext, TOutput> = Omit<
  ToolDefinition<TInput, TOutput>,
  "execute"
> & {
  execute(input: TInput, context: ToolContext | TWorkflowContext): Promise<TOutput>;
};

export type WorkflowBackedSubagentTool = WorkflowBackedTool<
  SubagentToolInput,
  SubagentWorkflowInvocationContext,
  JsonValue
> & {
  readonly [WORKFLOW_SUBAGENT_TARGET]: WorkflowSubagentTarget;
};

export interface PrototypeSubagentExecutorInput {
  readonly input: SubagentToolInput;
  readonly subagentInboxToken: string;
  readonly target: WorkflowSubagentTarget;
  readonly workflowInboxToken: string;
}

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

/** Ordinary workflow-backed tool proving that the primitive is not agent-specific. */
export async function executeWorkflowToolProbe(
  input: WorkflowToolProbeInput,
  context: ToolContext | WorkflowToolInvocationContext,
): Promise<WorkflowToolProbeOutput> {
  "use workflow";

  return { ...readWorkflowToolInvocationContext(context), value: input.value };
}

export function defineWorkflowToolProbe(): WorkflowBackedTool<
  WorkflowToolProbeInput,
  WorkflowToolInvocationContext,
  WorkflowToolProbeOutput
> {
  return defineWorkflowBackedTool({
    description: "Return the workflow-tool invocation descriptor",
    execute: executeWorkflowToolProbe,
    inputSchema: workflowToolProbeInputSchema,
  });
}

/** Prototype-owned local subagent tool workflow. */
export async function executeLocalSubagent(
  input: SubagentToolInput,
  context: ToolContext | SubagentWorkflowInvocationContext,
): Promise<JsonValue> {
  "use workflow";

  const invocation = readSubagentWorkflowInvocationContext(context);
  if (invocation.target.kind !== "local") {
    throw new Error("The local subagent workflow requires a local target.");
  }
  return await runSubagentWorkflowTool(input, invocation);
}

/** Prototype-owned remote subagent tool workflow. */
export async function executeRemoteSubagent(
  input: SubagentToolInput,
  context: ToolContext | SubagentWorkflowInvocationContext,
): Promise<JsonValue> {
  "use workflow";

  const invocation = readSubagentWorkflowInvocationContext(context);
  if (invocation.target.kind !== "remote") {
    throw new Error("The remote subagent workflow requires a remote target.");
  }
  return await runSubagentWorkflowTool(input, invocation);
}

/** Independent executor workflow selected for a local target by the dispatcher. */
export async function runLocalPrototypeSubagent(
  input: PrototypeSubagentExecutorInput,
): Promise<JsonValue> {
  "use workflow";

  if (input.target.kind !== "local") {
    throw new Error("The local prototype executor requires a local target.");
  }
  return await runPrototypeSubagent(input);
}

/** Independent executor workflow selected for a remote target by the dispatcher. */
export async function runRemotePrototypeSubagent(
  input: PrototypeSubagentExecutorInput,
): Promise<JsonValue> {
  "use workflow";

  if (input.target.kind !== "remote") {
    throw new Error("The remote prototype executor requires a remote target.");
  }
  return await runPrototypeSubagent(input);
}

/** Returns a real defineTool value with private dispatcher metadata. */
export function defineSubagent(definition: LocalSubagentDefinition): WorkflowBackedSubagentTool {
  return lowerSubagentToTool(definition.description, executeLocalSubagent, {
    kind: "local",
    nodeId: definition.nodeId,
  });
}

/** Remote counterpart with the same workflow-backed tool substrate. */
export function defineRemoteSubagent(
  definition: RemoteSubagentDefinition,
): WorkflowBackedSubagentTool {
  return lowerSubagentToTool(definition.description, executeRemoteSubagent, {
    kind: "remote",
    nodeId: definition.nodeId,
    url: definition.url,
  });
}

async function runSubagentWorkflowTool(
  _input: SubagentToolInput,
  context: SubagentWorkflowInvocationContext,
): Promise<JsonValue> {
  const inbox = createHook<PrototypeSubagentEnvelope>({ token: context.workflowInboxToken });
  const iterator = inbox[Symbol.asyncIterator]();
  const outstandingInputRequests = new Set<string>();

  try {
    await claimHookOwnership(inbox);

    while (true) {
      const next = await iterator.next();
      if (next.done === true) {
        throw new Error("The workflow-tool inbox closed before canonical output.");
      }

      const envelope = next.value;
      switch (envelope.kind) {
        case "task_post_message":
          await appendTranscriptStep({
            callId: context.callId,
            direction: "child-to-parent",
            envelope,
          });
          break;
        case "input.required":
          outstandingInputRequests.add(envelope.requestId);
          await appendTranscriptStep({
            callId: context.callId,
            direction: "child-to-parent",
            envelope,
          });
          break;
        case "input.response":
          if (!outstandingInputRequests.delete(envelope.requestId)) {
            throw new Error(`No input request is waiting for "${envelope.requestId}".`);
          }
          await appendTranscriptStep({
            callId: context.callId,
            direction: "parent-to-child",
            envelope,
          });
          await sendPrototypeEnvelopeStep({
            envelope,
            token: context.subagentInboxToken,
          });
          break;
        case "output":
          await appendTranscriptStep({
            callId: context.callId,
            direction: "child-to-parent",
            envelope,
          });
          return envelope.value;
      }
    }
  } finally {
    await closeHookIterator(iterator);
    await disposeHook(inbox);
  }
}

async function runPrototypeSubagent(input: PrototypeSubagentExecutorInput): Promise<JsonValue> {
  const responses = createHook<PrototypeSubagentEnvelope>({ token: input.subagentInboxToken });
  const iterator = responses[Symbol.asyncIterator]();
  const requestId = `${input.subagentInboxToken}:approval`;

  try {
    await claimHookOwnership(responses);
    await sendPrototypeEnvelopeStep({
      envelope: {
        kind: "task_post_message",
        message: `Started ${input.target.kind} executor ${input.target.nodeId}`,
        mode: "queue",
      },
      token: input.workflowInboxToken,
    });
    await sendPrototypeEnvelopeStep({
      envelope: {
        kind: "input.required",
        prompt: `Approve ${input.target.kind} executor ${input.target.nodeId}?`,
        requestId,
      },
      token: input.workflowInboxToken,
    });

    while (true) {
      const next = await iterator.next();
      if (next.done === true) {
        throw new Error("The prototype executor inbox closed before input arrived.");
      }
      if (next.value.kind !== "input.response" || next.value.requestId !== requestId) continue;

      const output = await completePrototypeSubagentStep({
        input: input.input,
        response: next.value.value,
        target: input.target,
      });
      await sendPrototypeEnvelopeStep({
        envelope: { kind: "output", value: output },
        token: input.workflowInboxToken,
      });
      return output;
    }
  } finally {
    await closeHookIterator(iterator);
    await disposeHook(responses);
  }
}

async function appendTranscriptStep(entry: PrototypeTranscriptEntry): Promise<void> {
  "use step";

  const writer = getWritable<PrototypeTranscriptEntry>({
    namespace: PROTOTYPE_TRANSCRIPT_STREAM,
  }).getWriter();
  try {
    await writer.write(entry);
  } finally {
    writer.releaseLock();
  }
}

async function sendPrototypeEnvelopeStep(input: {
  readonly envelope: PrototypeSubagentEnvelope;
  readonly token: string;
}): Promise<void> {
  "use step";

  await resumeHook(input.token, input.envelope);
}

async function completePrototypeSubagentStep(input: {
  readonly input: SubagentToolInput;
  readonly response: JsonValue;
  readonly target: WorkflowSubagentTarget;
}): Promise<JsonObject> {
  "use step";

  const executor: JsonObject =
    input.target.kind === "remote"
      ? { kind: input.target.kind, nodeId: input.target.nodeId, url: input.target.url }
      : { kind: input.target.kind, nodeId: input.target.nodeId };

  return {
    approved: input.response,
    executor,
    message: input.input.message,
  };
}

function lowerSubagentToTool(
  description: string,
  workflow: WorkflowBackedSubagentTool["execute"],
  target: WorkflowSubagentTarget,
): WorkflowBackedSubagentTool {
  const tool = defineWorkflowBackedTool<
    SubagentToolInput,
    SubagentWorkflowInvocationContext,
    JsonValue
  >({
    description,
    execute: workflow,
    inputSchema: subagentInputSchema,
  });

  return Object.assign(tool, { [WORKFLOW_SUBAGENT_TARGET]: target });
}

function defineWorkflowBackedTool<TInput, TWorkflowContext, TOutput>(
  definition: WorkflowBackedTool<TInput, TWorkflowContext, TOutput>,
): WorkflowBackedTool<TInput, TWorkflowContext, TOutput> {
  defineTool<TInput, TOutput>(definition);
  return definition;
}

function readWorkflowToolInvocationContext(
  context: ToolContext | WorkflowToolInvocationContext,
): WorkflowToolInvocationContext {
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
  context: ToolContext | SubagentWorkflowInvocationContext,
): SubagentWorkflowInvocationContext {
  const base = readWorkflowToolInvocationContext(context);
  if (
    !isRecord(context) ||
    typeof context.subagentInboxToken !== "string" ||
    typeof context.workflowInboxToken !== "string" ||
    !isWorkflowSubagentTarget(context.target)
  ) {
    throw new Error("Subagent workflow dispatch requires prototype inboxes and a target.");
  }

  return {
    ...base,
    subagentInboxToken: context.subagentInboxToken,
    target: context.target,
    workflowInboxToken: context.workflowInboxToken,
  };
}

function isWorkflowSubagentTarget(value: unknown): value is WorkflowSubagentTarget {
  if (!isRecord(value) || typeof value.nodeId !== "string") return false;
  if (value.kind === "local") return true;
  return value.kind === "remote" && typeof value.url === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
