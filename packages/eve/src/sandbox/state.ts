import { parseJsonValue } from "#shared/json.js";
import type { Sandbox, SerializedSandbox } from "#shared/sandbox-value.js";

/**
 * Serializable sandbox value stored on the durable eve session.
 */
export interface SandboxStateValue {
  readonly revision: string;
  readonly value: SerializedSandbox;
}

export interface SandboxState extends SandboxStateValue {
  readonly root?: SandboxStateValue;
}

/**
 * Returns whether a workflow value is a complete serialized sandbox state.
 */
export function isSandboxStateValue(value: unknown): value is SandboxStateValue {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const state = value as Partial<SandboxStateValue>;
  const sandbox = state.value;
  if (
    typeof state.revision !== "string" ||
    sandbox === null ||
    typeof sandbox !== "object" ||
    typeof sandbox.adapterId !== "string" ||
    typeof sandbox.id !== "string" ||
    typeof sandbox.resourceId !== "string"
  ) {
    return false;
  }

  try {
    parseJsonValue(sandbox.reference);
    return true;
  } catch {
    return false;
  }
}

/**
 * Lazy sandbox accessor bound to one step execution.
 */
export interface SandboxAccess {
  captureState(): Promise<SandboxState | null>;
  get(): Promise<Sandbox | null>;
}
