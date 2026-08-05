import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { JsonObject } from "#shared/json.js";
import {
  toInputSchema,
  toOutputSchema,
  type ToolSchema,
  type ToolSchemaSource,
} from "#shared/tool-schema.js";

const log = createLogger("dynamic-tools");

export const DYNAMIC_TOOL_INPUT_SCHEMA_FACTORY_PROPERTY = "__eveInputSchemaFactory";
export const DYNAMIC_TOOL_OUTPUT_SCHEMA_FACTORY_PROPERTY = "__eveOutputSchemaFactory";

type DynamicToolSchemaFactory = (
  closureVars: Record<string, unknown>,
) => ToolSchemaSource | undefined;

/** Registered dynamic-tool execute function with optional live schema factories. */
export type DynamicToolStepFunction = ((...args: unknown[]) => unknown) & {
  [DYNAMIC_TOOL_INPUT_SCHEMA_FACTORY_PROPERTY]?: DynamicToolSchemaFactory;
  [DYNAMIC_TOOL_OUTPUT_SCHEMA_FACTORY_PROPERTY]?: DynamicToolSchemaFactory;
};

/** Restores the original live input validator when the transform registered one. */
export function replayDynamicToolInputSchema(input: {
  readonly closureVars: Record<string, unknown>;
  readonly fallback: JsonObject;
  readonly stepFn: DynamicToolStepFunction;
  readonly toolName: string;
}): ToolSchema {
  return replayDynamicToolSchema({
    ...input,
    direction: "input",
  }) as ToolSchema;
}

/** Restores the original live output validator when the transform registered one. */
export function replayDynamicToolOutputSchema(input: {
  readonly closureVars: Record<string, unknown>;
  readonly fallback: JsonObject | undefined;
  readonly stepFn: DynamicToolStepFunction;
  readonly toolName: string;
}): ToolSchema | undefined {
  return replayDynamicToolSchema({
    ...input,
    direction: "output",
  });
}

function replayDynamicToolSchema(input: {
  readonly closureVars: Record<string, unknown>;
  readonly direction: "input" | "output";
  readonly fallback: JsonObject | undefined;
  readonly stepFn: DynamicToolStepFunction;
  readonly toolName: string;
}): ToolSchema | undefined {
  const property =
    input.direction === "input"
      ? DYNAMIC_TOOL_INPUT_SCHEMA_FACTORY_PROPERTY
      : DYNAMIC_TOOL_OUTPUT_SCHEMA_FACTORY_PROPERTY;
  const factory = input.stepFn[property];
  if (factory === undefined) {
    return input.direction === "input"
      ? toInputSchema(input.fallback)
      : toOutputSchema(input.fallback);
  }

  try {
    const source = factory(input.closureVars);
    if (input.direction === "input" && source === undefined) {
      throw new Error("The input schema factory returned undefined.");
    }
    return input.direction === "input" ? toInputSchema(source) : toOutputSchema(source);
  } catch (error) {
    log.warn(
      `Dynamic tool "${input.toolName}" could not restore its live ${input.direction} schema; ` +
        "falling back to serialized JSON Schema. Custom validation may not be enforced.",
      { error: toErrorMessage(error) },
    );
    return input.direction === "input"
      ? toInputSchema(input.fallback)
      : toOutputSchema(input.fallback);
  }
}
