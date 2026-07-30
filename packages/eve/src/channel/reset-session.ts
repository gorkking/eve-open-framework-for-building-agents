import type { ResetFn, ResetOptions, ResetResult } from "#channel/routes.js";
import type { Runtime } from "#channel/types.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { executeGatedReset } from "#channel/gated-operations.js";

/**
 * Builds a channel-scoped session reset helper. It resolves an owner once and
 * retires that observed session id, so it can never cancel a later owner that
 * claimed the same continuation token.
 */
export function createResetFn(
  runtime: Runtime,
  channelName: string,
  adapter: ChannelAdapter = { kind: "channel" },
): ResetFn {
  return async (options: ResetOptions): Promise<ResetResult> => {
    const continuationToken = `${channelName}:${options.continuationToken}`;
    const owner = await runtime.resolveSession(continuationToken);

    if (owner === undefined) {
      return { status: "no_active_session" };
    }

    const result = await executeGatedReset({
      adapter,
      auth: options.auth,
      continuationToken,
      reason: options.reason,
      runtime,
      sessionId: owner.sessionId,
    });
    if (result === undefined) {
      return { status: "no_active_session" };
    }

    return { status: "reset", previousSessionId: owner.sessionId };
  };
}
