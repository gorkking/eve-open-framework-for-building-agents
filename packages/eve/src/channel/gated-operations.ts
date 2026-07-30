import type { ChannelAdapter } from "#channel/adapter.js";
import type {
  CancelTurnResult,
  DeliverInput,
  Runtime,
  SessionAuthContext,
  TerminateSessionResult,
} from "#channel/types.js";
import { isRuntimeNoActiveSessionError } from "#execution/runtime-errors.js";

/** Requests a turn cancellation through its configured channel gate. */
export async function executeGatedCancel(input: {
  readonly adapter: ChannelAdapter;
  readonly auth: SessionAuthContext | null;
  readonly continuationToken?: string;
  readonly runtime: Runtime;
  readonly sessionId: string;
  readonly turnId?: string;
}): Promise<CancelTurnResult> {
  if (input.adapter.gates?.["turn.cancel"] === undefined) {
    return await input.runtime.cancelTurn({
      sessionId: input.sessionId,
      turnId: input.turnId,
    });
  }
  return await input.runtime.cancelTurn({
    auth: input.auth,
    continuationToken: input.continuationToken,
    gate: {
      adapterKind: input.adapter.kind,
      names: ["turn.cancel"],
    },
    sessionId: input.sessionId,
    turnId: input.turnId,
  });
}

/** Terminates a session through its configured channel gate. */
export async function executeGatedReset(input: {
  readonly adapter: ChannelAdapter;
  readonly auth: SessionAuthContext | null;
  readonly continuationToken: string;
  readonly reason?: string;
  readonly runtime: Runtime;
  readonly sessionId: string;
}): Promise<TerminateSessionResult | undefined> {
  if (input.adapter.gates?.["session.reset"] === undefined) {
    return await input.runtime.terminateSession({
      reason: input.reason,
      sessionId: input.sessionId,
    });
  }

  try {
    return await input.runtime.terminateSession({
      auth: input.auth,
      continuationToken: input.continuationToken,
      gate: {
        adapterKind: input.adapter.kind,
        names: ["session.reset"],
      },
      reason: input.reason,
      sessionId: input.sessionId,
    });
  } catch (error) {
    if (isRuntimeNoActiveSessionError(error)) return undefined;
    throw error;
  }
}

/** Delivers a follow-up through the configured resume/input-response gates. */
export async function executeGatedDelivery(input: {
  readonly adapter: ChannelAdapter;
  readonly delivery: DeliverInput & { readonly auth: SessionAuthContext | null };
  readonly runtime: Runtime;
}): Promise<{ readonly sessionId: string }> {
  const names = [
    ...(input.adapter.gates?.["session.resume"] === undefined ? [] : (["session.resume"] as const)),
    ...(input.adapter.gates?.["input.response"] === undefined ? [] : (["input.response"] as const)),
  ];
  return await input.runtime.deliver({
    ...input.delivery,
    ...(names.length === 0
      ? {}
      : {
          gate: {
            adapterKind: input.adapter.kind,
            names,
          },
        }),
  });
}
