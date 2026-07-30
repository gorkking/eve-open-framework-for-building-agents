import { createHook } from "#compiled/@workflow/core/index.js";

import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import {
  sessionCancelHookToken,
  type TurnInterruptionPayload,
} from "#execution/turn-cancellation-token.js";
import { TurnCancelledError } from "#harness/turn-cancellation.js";

/**
 * Owns one turn's cancellation surface inside the turn workflow: the
 * session-scoped cancel hook and the durable `AbortController` whose
 * signal is serialized into every `turnStep`. Must be created inside a
 * `"use workflow"` body.
 */
export interface TurnCancellationControl {
  /** Turn signal to serialize into each `turnStep` input. */
  readonly signal: AbortSignal;
  /**
   * Resolves `"cancel"` once a matching cancel payload is consumed and
   * the signal aborted. Race it against turn-owned awaits — never
   * `await` it alone.
   */
  readonly requested: Promise<"cancel" | "reset">;
  /** Disposes the hook, abandoning any outstanding read. Idempotent. */
  dispose(): Promise<void>;
}

/**
 * Creates and claims the session cancel hook for one turn workflow run.
 * Returns `undefined` when the token is still claimed by a crashed prior
 * run — the turn then runs uncancellable rather than failing.
 */
export async function createTurnCancellationControl(input: {
  readonly acceptReset?: boolean;
  readonly authorize?: (payload: TurnInterruptionPayload, available: boolean) => Promise<boolean>;
  readonly canCancel?: boolean;
  readonly expectedTurnId: string;
  readonly sessionId: string;
}): Promise<TurnCancellationControl | undefined> {
  const hook = createHook<TurnInterruptionPayload>({
    token: sessionCancelHookToken(input.sessionId),
  });
  // Hook promises and iterators share one durable cursor. Create the
  // iterator before claiming so conflict replay is consumed by
  // getConflict(), not a later iterator read.
  const iterator = hook[Symbol.asyncIterator]();

  try {
    await claimHookOwnership(hook);
  } catch (error) {
    if (isHookConflictError(error)) return undefined;
    throw error;
  }

  const controller = new AbortController();
  // The durable abort fires in the read's continuation so its call site
  // is reached deterministically on every replay.
  const requested = consumeAllowedInterruption(iterator, input).then((kind) => {
    controller.abort(new TurnCancelledError());
    return kind;
  });

  let disposed = false;
  return {
    signal: controller.signal,
    requested,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Never `iterator.return()`: it would await the pending durable
      // read forever, leaving the run `running` and its hooks unswept.
      await disposeHook(hook);
    },
  };
}

// Mismatched turn guards are consumed as no-ops; each read is durable,
// so the skip sequence replays deterministically.
async function consumeAllowedInterruption(
  iterator: AsyncIterator<TurnInterruptionPayload>,
  input: {
    readonly acceptReset?: boolean;
    readonly authorize?: (payload: TurnInterruptionPayload, available: boolean) => Promise<boolean>;
    readonly canCancel?: boolean;
    readonly expectedTurnId: string;
  },
): Promise<"cancel" | "reset"> {
  while (true) {
    const next = await iterator.next();
    if (next.done) return await new Promise<never>(() => {});
    const payload = next.value;
    if (payload.kind === "reset") {
      if (input.acceptReset !== true) continue;
      if ((await input.authorize?.(payload, true)) === true) return "reset";
      continue;
    }

    const available = input.canCancel !== false && matchesActiveTurn(payload, input.expectedTurnId);
    if (payload.gateOperation !== undefined) {
      if ((await input.authorize?.(payload, available)) === true) return "cancel";
      continue;
    }
    if (available) return "cancel";
  }
}

function matchesActiveTurn(payload: unknown, expectedTurnId: string): boolean {
  if (typeof payload !== "object" || payload === null) return true;
  const guard = (payload as TurnInterruptionPayload & { readonly turnId?: string }).turnId;
  return guard === undefined || guard === expectedTurnId;
}
