import { createUlid } from "#shared/ulid.js";

/** Opaque eve identity for one logical harness step. */
export type StepId = `stp_${string}`;

/** Opaque eve identity for one physical model execution. */
export type AttemptId = `atp_${string}`;

export interface StepExecutionContext {
  readonly sequence: number;
  readonly stepId: StepId;
  readonly stepIndex: number;
  readonly turnId: string;
}

export interface AttemptExecutionContext extends StepExecutionContext {
  readonly attemptId: AttemptId;
}

/** Coordinates persisted by parks; IDs are optional for pre-v22 state. */
export interface DurableEventOrigin {
  readonly attemptId?: string;
  readonly sequence: number;
  readonly stepId?: string;
  readonly stepIndex: number;
  readonly turnId: string;
}

export function createStepId(): StepId {
  return `stp_${createUlid()}`;
}

export function createAttemptId(): AttemptId {
  return `atp_${createUlid()}`;
}

/**
 * Converts a Workflow-owned stable step id into an eve-owned wire identity.
 * The Workflow value is deliberately never exposed to consumers.
 */
export async function stepIdFromWorkflowStepId(workflowStepId: string): Promise<StepId> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(workflowStepId),
  );
  const hash = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `stp_${hash}`;
}
