import { deriveAgentOperationId } from "#harness/handles/operation-id.js";

/**
 * Derives the stable task id for one originating subagent call.
 *
 * Reuses the agent-handle operation-id derivation —
 * `hash(parentSessionId, parentTurnId, callId)` — so replayed creation
 * for the same call yields the same task without new machinery, and a
 * task can never be confused with a child session id or continuation
 * token.
 *
 * Lives apart from the pure task modules because the derivation needs
 * `node:crypto`, which workflow bodies reject; ids are only ever minted
 * inside dispatch steps.
 */
export function deriveTaskId(input: {
  readonly callId: string;
  readonly parentSessionId: string;
  readonly parentTurnId: string;
}): string {
  return `task_${deriveAgentOperationId(input).slice(0, 24)}`;
}
