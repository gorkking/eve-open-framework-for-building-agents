import type { CancelFn, CancelOptions } from "#channel/routes.js";
import type { CancelTurnResult, Runtime } from "#channel/types.js";
import type { ChannelAdapter } from "#channel/adapter.js";
import { executeGatedCancel } from "#channel/gated-operations.js";

/**
 * Builds the route-handler `cancel` helper for one channel. Resolves the
 * channel-local continuation token to its owning session without delivering
 * input, then delegates to the runtime's session-id-addressed cancellation.
 */
export function createCancelFn(
  runtime: Runtime,
  channelName: string,
  adapter: ChannelAdapter = { kind: "channel" },
): CancelFn {
  return async (options: CancelOptions): Promise<CancelTurnResult> => {
    const continuationToken = `${channelName}:${options.continuationToken}`;
    const owner = await runtime.resolveSession(continuationToken);

    if (owner === undefined) {
      return { status: "no_active_turn" };
    }

    return await executeGatedCancel({
      adapter,
      auth: options.auth,
      continuationToken,
      runtime,
      sessionId: owner.sessionId,
      turnId: options.turnId,
    });
  };
}
