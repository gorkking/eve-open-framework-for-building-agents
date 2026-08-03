import type { UserContent } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { RunInput, Runtime, SessionAuthContext, SessionCommand } from "#channel/types.js";
import { createSession, type FixedSession, type Session } from "#channel/session.js";
import type { SendOptions, SendPayload } from "#channel/routes.js";
import { normalizeSendInput, serializeUrlFilePartsInMessage } from "#channel/send-input.js";
import { isRuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";

type RuntimeSendFn<TState> = (
  input: string | UserContent | SendPayload,
  options: SendOptions<TState>,
) => Promise<Session & FixedSession>;

export function createSendFn<TState = undefined>(
  runtime: Runtime,
  adapter: ChannelAdapter<any>,
  channelName: string,
  metadata: { readonly requestId?: string } = {},
): RuntimeSendFn<TState> {
  return async (
    input: string | UserContent | SendPayload,
    options: SendOptions<TState>,
  ): Promise<Session & FixedSession> => {
    const auth = (options as { auth: SessionAuthContext | null }).auth;
    const initiatorAuth = (options as { initiatorAuth?: SessionAuthContext | null }).initiatorAuth;
    const callback = (options as { callback?: SendOptions<TState>["callback"] }).callback;
    const mode = (options as { mode?: SendOptions<TState>["mode"] }).mode ?? "conversation";
    const state = (options as { state?: TState }).state;
    const title = (options as { title?: string }).title;
    const rawToken = (options as { continuationToken: string }).continuationToken;
    const continuationToken = `${channelName}:${rawToken}`;

    const {
      message: rawMessage,
      inputResponses,
      context,
      outputSchema,
    } = normalizeSendInput(input);
    const message = serializeUrlFilePartsInMessage(rawMessage);

    const command: Extract<SessionCommand, { readonly kind: "send" }> = {
      auth,
      kind: "send",
      payload: { inputResponses, message, context, outputSchema },
      requestId: metadata.requestId,
    };

    const dispatch = async (): Promise<(Session & FixedSession) | undefined> => {
      const result = await runtime.dispatchContinuation({
        command,
        continuationToken,
      });
      return result.status === "accepted"
        ? createSession(result.sessionId, rawToken, runtime, metadata)
        : undefined;
    };

    const existing = await dispatch();
    if (existing !== undefined) return existing;

    if (inputResponses && inputResponses.length > 0) {
      throw new Error(
        "Cannot deliver inputResponses — the target session was not found via continuation token.",
      );
    }

    const sessionAdapter = state
      ? { ...adapter, state: { ...adapter.state, ...(state as Record<string, unknown>) } }
      : adapter;

    const runInput: {
      -readonly [K in keyof RunInput]: RunInput[K];
    } = {
      adapter: sessionAdapter,
      auth,
      capabilities: mode === "conversation" ? { requestInput: true } : undefined,
      channelName,
      callback,
      continuationToken,
      input: { message: message ?? "", context, outputSchema },
      mode,
      requestId: metadata.requestId,
      title,
    };
    if (initiatorAuth !== undefined) {
      runInput.initiatorAuth = initiatorAuth;
    }
    try {
      const handle = await runtime.createSession(runInput);
      return createSession(handle.sessionId, rawToken, runtime, metadata);
    } catch (error) {
      if (!isRuntimeSessionOwnershipConflictError(error)) throw error;
      const winner = await dispatch();
      if (winner !== undefined) return winner;
      throw error;
    }
  };
}
