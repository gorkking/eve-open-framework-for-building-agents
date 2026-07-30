/**
 * Reads newline-delimited JSON values from a byte stream.
 *
 * Partial lines are buffered across chunks, the decoder is flushed at EOF,
 * and trailing JSON without a final newline is yielded.
 */
export async function* readNdjsonStream<T>(body: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEof = false;

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) {
        reachedEof = true;
        buffer += decoder.decode();
        break;
      }

      if (result.value) {
        buffer += decoder.decode(result.value, { stream: true });
      }

      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);

        if (line.length > 0) {
          yield JSON.parse(line) as T;
        }

        newlineIndex = buffer.indexOf("\n");
      }
    }

    const trailing = buffer.trim();
    if (trailing.length > 0) {
      yield JSON.parse(trailing) as T;
    }
  } finally {
    if (!reachedEof) {
      await reader.cancel().catch(() => {});
    }
    reader.releaseLock();
  }
}
