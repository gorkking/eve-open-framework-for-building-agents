import type { ChannelGateName } from "#channel/gates.js";

/** Base class for failures raised while protecting a channel operation. */
export class ChannelGateError extends Error {
  readonly gate: ChannelGateName;

  constructor(message: string, gate: ChannelGateName, options?: ErrorOptions) {
    super(message, options);
    this.name = "ChannelGateError";
    this.gate = gate;
  }
}

/** Raised when an authored gate explicitly denies an operation. */
export class ChannelGateDeniedError extends ChannelGateError {
  readonly reason?: string;

  constructor(gate: ChannelGateName, reason?: string) {
    super(reason ?? `Channel gate "${gate}" denied the operation.`, gate);
    this.name = "ChannelGateDeniedError";
    this.reason = reason;
  }
}

/**
 * Raised when a configured gate cannot be evaluated safely.
 *
 * The protected operation remains blocked; callers may retry or start a new
 * session when the target predates the gate readiness protocol.
 */
export class ChannelGateUnavailableError extends ChannelGateError {
  readonly errorId?: string;

  constructor(gate: ChannelGateName, options?: ErrorOptions & { readonly errorId?: string }) {
    super(`Channel gate "${gate}" is unavailable.`, gate, options);
    this.name = "ChannelGateUnavailableError";
    this.errorId = options?.errorId;
  }
}
