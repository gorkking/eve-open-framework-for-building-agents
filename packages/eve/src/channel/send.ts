import type { FilePart, UserContent } from "ai";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { RunInput, Runtime, SessionAuthContext, SessionCommand } from "#channel/types.js";
import { createSession, type Session } from "#channel/session.js";
import type { SendFn, SendOptions, SendPayload } from "#channel/routes.js";
import { isRuntimeSessionOwnershipConflictError } from "#execution/runtime-errors.js";
import { serializeUrlFilePart } from "#internal/attachments/url-refs.js";

export function createSendFn<TState = undefined>(
  runtime: Runtime,
  adapter: ChannelAdapter<any>,
  channelName: string,
  metadata: { readonly requestId?: string } = {},
): SendFn<TState> {
  return async (
    input: string | UserContent | SendPayload,
    options: SendOptions<TState>,
  ): Promise<Session> => {
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

    const dispatch = async (): Promise<Session | undefined> => {
      const result = await runtime.dispatchContinuation({
        command,
        continuationToken,
      });
      return result.status === "accepted"
        ? createSession(result.sessionId, rawToken, runtime)
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
      return createSession(handle.sessionId, rawToken, runtime);
    } catch (error) {
      if (!isRuntimeSessionOwnershipConflictError(error)) throw error;
      const winner = await dispatch();
      if (winner !== undefined) return winner;
      throw error;
    }
  };
}

/**
 * Serializes `URL` objects in `FilePart.data` to `eve-url:` strings
 * before the message crosses the queue boundary. The staging pipeline
 * reconstitutes them on the other side.
 */
function serializeUrlFilePartsInMessage(
  message: string | UserContent | undefined,
): string | UserContent | undefined {
  if (message === undefined || typeof message === "string") {
    return message;
  }
  let changed = false;
  const result = message.map((part): FilePart | typeof part => {
    if (part.type === "file" && part.data instanceof URL && part.data.protocol !== "data:") {
      changed = true;
      return { ...part, data: serializeUrlFilePart(part.data) };
    }
    return part;
  });
  return changed ? result : message;
}

function normalizeSendInput(input: string | UserContent | SendPayload): SendPayload {
  if (typeof input === "string") {
    return { message: input };
  }

  if (Array.isArray(input)) {
    return { message: input };
  }

  return input;
}
