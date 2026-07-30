import type { ChannelGateOperation, ChannelGateReceipt } from "#channel/types.js";
import type { SessionChannelGateName } from "#channel/gates.js";

export const CHANNEL_GATE_READY_NAMESPACE = "eve.channel-gates.ready";
export const CHANNEL_GATE_RECEIPT_NAMESPACE = "eve.channel-gates.receipts";
export const CHANNEL_GATE_PROTOCOL_VERSION = 1;

/** Immutable marker proving that a session can evaluate target-owned gates. */
export interface ChannelGateReady {
  readonly adapterKind: string;
  readonly names: readonly SessionChannelGateName[];
  readonly version: typeof CHANNEL_GATE_PROTOCOL_VERSION;
}

/** Result returned to a workflow body after evaluating one gate operation. */
export type ChannelGateEvaluation = { readonly status: "allow" } | { readonly status: "block" };

/** Input common to each target-owned gate evaluation step. */
export interface ChannelGateStepInput {
  readonly operation: ChannelGateOperation;
  readonly receiptWritable?: WritableStream<ChannelGateReceipt>;
  readonly serializedContext: Record<string, unknown>;
  readonly sessionState: import("#execution/durable-session-store.js").DurableSessionState;
}
