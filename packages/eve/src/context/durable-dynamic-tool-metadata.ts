import type {
  DurableDynamicToolMetadata,
  RuntimeToolContributionProvenance,
} from "#context/keys.js";
import type { DynamicToolEntry } from "#shared/dynamic-tool-definition.js";
import {
  registerDurableDynamicCallback,
  readDurableDynamicToolCallbacks,
  type DurableDynamicCallbackPhase,
  type DurableDynamicCallbackReference,
  type DurableDynamicToolCallbacks,
  type StampedDurableDynamicCallback,
} from "#shared/durable-dynamic-tool-callbacks.js";
import { toErrorMessage } from "#shared/errors.js";
import { parseJsonObject } from "#shared/json.js";
import { serializeInputSchema, serializeOutputSchema } from "#shared/tool-schema.js";

/**
 * Shared construction/validation for durable dynamic tool metadata. Kept
 * separate from the authored-resolver lifecycle so runtime tool
 * contributions can build identical metadata without importing the
 * lifecycle module.
 */

function validateReference(input: {
  readonly name: string;
  readonly phase: DurableDynamicCallbackPhase;
  readonly stamped: StampedDurableDynamicCallback | undefined;
  readonly required: boolean;
}): DurableDynamicCallbackReference | undefined {
  if (input.stamped === undefined) {
    if (input.required) {
      throw new Error(
        `Dynamic tool "${input.name}" callback "${input.phase}" does not have a durable descriptor. ` +
          "Author the callback inline in transformed source or use an eve durable callback helper.",
      );
    }
    return undefined;
  }
  const unknownKeys = Object.keys(input.stamped).filter(
    (key) => key !== "closure" && key !== "callback",
  );
  if (unknownKeys.includes("stepId")) {
    throw new Error(
      `Dynamic tool "${input.name}" callback "${input.phase}" was persisted by a pre-release eve ` +
        "version that identified callbacks by build offset. Start a new session to re-resolve it.",
    );
  }
  if (unknownKeys.length > 0) {
    throw new Error(
      `Dynamic tool "${input.name}" has invalid ${input.phase} callback metadata: unknown key(s) ${unknownKeys.join(", ")}.`,
    );
  }
  if (typeof input.stamped.callback !== "function") {
    throw new Error(
      `Dynamic tool "${input.name}" callback "${input.phase}" does not have a durable descriptor. ` +
        "Author the callback inline in transformed source or use an eve durable callback helper.",
    );
  }
  let closure: DurableDynamicCallbackReference["closure"];
  try {
    closure = parseJsonObject(input.stamped.closure);
  } catch (error) {
    throw new Error(
      `Dynamic tool "${input.name}" callback "${input.phase}" has a non-serializable capture. ${toErrorMessage(error)}`,
    );
  }
  registerDurableDynamicCallback({
    callback: input.stamped.callback,
    phase: input.phase,
    toolName: input.name,
  });
  return { closure };
}

export function validateDurableDynamicToolCallbacks(
  name: string,
  entry: DynamicToolEntry,
): DurableDynamicToolCallbacks {
  const raw = readDurableDynamicToolCallbacks(entry) ?? {};
  const unknownPhases = Object.keys(raw).filter(
    (key) =>
      key !== "execute" &&
      key !== "approvalRequest" &&
      key !== "approvalResponse" &&
      key !== "toModelOutput",
  );
  if (unknownPhases.length > 0) {
    throw new Error(
      `Dynamic tool "${name}" has unknown durable callback phase(s): ${unknownPhases.join(", ")}.`,
    );
  }

  const hasApproval = entry.approval !== undefined;
  const hasApprovalResponse =
    entry.approval !== undefined &&
    typeof entry.approval !== "function" &&
    entry.approval.response !== undefined;
  const execute = validateReference({
    name,
    phase: "execute",
    stamped: raw.execute,
    required: true,
  })!;
  const approvalRequest = validateReference({
    name,
    phase: "approvalRequest",
    stamped: raw.approvalRequest,
    required: hasApproval,
  });
  const approvalResponse = validateReference({
    name,
    phase: "approvalResponse",
    stamped: raw.approvalResponse,
    required: hasApprovalResponse,
  });
  const toModelOutput = validateReference({
    name,
    phase: "toModelOutput",
    stamped: raw.toModelOutput,
    required: entry.toModelOutput !== undefined,
  });

  const callbacks: {
    execute: DurableDynamicCallbackReference;
    approvalRequest?: DurableDynamicCallbackReference;
    approvalResponse?: DurableDynamicCallbackReference;
    toModelOutput?: DurableDynamicCallbackReference;
  } = { execute };
  if (approvalRequest !== undefined) callbacks.approvalRequest = approvalRequest;
  if (approvalResponse !== undefined) callbacks.approvalResponse = approvalResponse;
  if (toModelOutput !== undefined) callbacks.toModelOutput = toModelOutput;
  return callbacks;
}

export function createDurableDynamicToolMetadata(input: {
  readonly entry: DynamicToolEntry;
  readonly entryKey: string;
  readonly name: string;
  readonly resolverSlug: string;
  readonly provenance?: RuntimeToolContributionProvenance;
}): DurableDynamicToolMetadata {
  const metadata = {
    callbacks: validateDurableDynamicToolCallbacks(input.name, input.entry),
    description: input.entry.description,
    entryKey: input.entryKey,
    inputSchema: serializeInputSchema(input.entry.inputSchema),
    name: input.name,
    outputSchema: serializeOutputSchema(input.entry.outputSchema),
    resolverSlug: input.resolverSlug,
  };
  if (input.provenance === undefined) return metadata;
  return { ...metadata, contribution: input.provenance };
}
