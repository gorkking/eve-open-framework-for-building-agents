import type { Sandbox, SerializedSandbox } from "#shared/sandbox-value.js";

/**
 * Owner of one durable sandbox value.
 */
export interface SandboxOwner {
  readonly nodeId: string;
  readonly sessionId: string;
}

/**
 * Serializable sandbox value stored on the durable eve session.
 */
export interface SandboxStateValue {
  readonly owner: SandboxOwner;
  readonly revision: string;
  readonly value: SerializedSandbox;
}

export interface SandboxState extends SandboxStateValue {
  readonly root?: SandboxStateValue;
}

/**
 * Lazy sandbox accessor bound to one step execution.
 */
export interface SandboxAccess {
  captureState(): Promise<SandboxState | null>;
  get(): Promise<Sandbox | null>;
}
