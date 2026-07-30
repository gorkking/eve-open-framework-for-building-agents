import type { ChannelGateOperation } from "#channel/types.js";

/** Derives the stable session-scoped cancellation hook token. */
export function sessionCancelHookToken(sessionId: string): string {
  return `${sessionId}:cancel`;
}

/**
 * Payload accepted by the session cancel hook. A mismatched `turnId` is a
 * benign no-op; omitting it targets whichever turn owns the hook.
 */
export interface TurnCancelPayload {
  readonly continuationToken?: string;
  readonly gateOperation?: ChannelGateOperation;
  readonly kind?: "cancel";
  readonly turnId?: string;
}

/** Gated reset delivered to whichever turn currently owns session control. */
export interface TurnResetPayload {
  readonly continuationToken: string;
  readonly gateOperation: ChannelGateOperation;
  readonly kind: "reset";
  readonly reason?: string;
}

/** Public interruption payloads consumed serially by the active turn. */
export type TurnInterruptionPayload = TurnCancelPayload | TurnResetPayload;
