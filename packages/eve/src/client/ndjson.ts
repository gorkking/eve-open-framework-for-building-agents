import type { MessageStreamEvent } from "#protocol/message.js";
import { readNdjsonStream as readSharedNdjsonStream } from "#shared/ndjson.js";

/**
 * Returns true when an error looks like a stream socket disconnection that
 * can be recovered via reconnection.
 */
export function isStreamDisconnectError(error: unknown): boolean {
  if (error instanceof DOMException) {
    return error.name === "AbortError";
  }

  if (!(error instanceof Error)) {
    return false;
  }

  const errorCode = "code" in error && typeof error.code === "string" ? error.code : undefined;

  return (
    error.name === "AbortError" ||
    error.message === "terminated" ||
    errorCode === "UND_ERR_SOCKET" ||
    (error instanceof TypeError && /^(?:failed to fetch|fetch failed)$/i.test(error.message)) ||
    /abort|cancel|disconnect|premature close|socket|terminated/i.test(error.message)
  );
}

/**
 * Reads newline-delimited JSON events from a `ReadableStream<Uint8Array>`.
 *
 * Yields one parsed {@link MessageStreamEvent} per complete NDJSON line.
 * Handles partial lines across chunks via an internal buffer.
 *
 * All read errors — including socket disconnections — propagate to the caller.
 * Use {@link isStreamDisconnectError} to classify them.
 */
export function readNdjsonStream(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<MessageStreamEvent> {
  return readSharedNdjsonStream<MessageStreamEvent>(body);
}
