import { afterEach, describe, expect, it, vi } from "vitest";

import { ChannelGateDeniedError, ChannelGateUnavailableError } from "#channel/gate-errors.js";
import type { ChannelGateReceipt } from "#channel/types.js";
import {
  CHANNEL_GATE_PROTOCOL_VERSION,
  CHANNEL_GATE_READY_NAMESPACE,
  CHANNEL_GATE_RECEIPT_NAMESPACE,
  type ChannelGateReady,
} from "#execution/channel-gate-protocol.js";
import { prepareChannelGateOperation } from "#execution/channel-gate-runtime.js";

const getRunMock = vi.fn();

vi.mock("#internal/workflow/runtime.js", () => ({
  getRun: (...args: unknown[]) => getRunMock(...args),
}));

afterEach(() => {
  getRunMock.mockReset();
});

describe("prepareChannelGateOperation", () => {
  it("opens the receipt cursor before returning the operation and resolves its allow receipt", async () => {
    const receipts = controllableStream<ChannelGateReceipt>();
    installRunStreams(receipts.stream);

    const handle = await prepareChannelGateOperation({
      auth: null,
      gate: { adapterKind: "channel:test", names: ["session.resume"] },
      sessionId: "session-1",
    });
    receipts.controller.enqueue({ id: handle.operation.id, status: "allow" });

    await expect(handle.wait()).resolves.toBe("allow");
    expect(handle.operation).toMatchObject({
      adapterKind: "channel:test",
      auth: null,
      names: ["session.resume"],
    });
  });

  it("maps a target denial to the typed public error with its safe reason", async () => {
    const receipts = controllableStream<ChannelGateReceipt>();
    installRunStreams(receipts.stream);

    const handle = await prepareChannelGateOperation({
      auth: null,
      gate: { adapterKind: "channel:test", names: ["input.response"] },
      sessionId: "session-1",
    });
    receipts.controller.enqueue({
      gate: "input.response",
      id: handle.operation.id,
      reason: "Only the initiator may answer.",
      status: "denied",
    });

    const error = await handle.wait().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ChannelGateDeniedError);
    expect(error).toMatchObject({
      gate: "input.response",
      reason: "Only the initiator may answer.",
    });
  });

  it("fails closed when the session does not advertise the requested gate", async () => {
    installRunStreams(
      controllableStream<ChannelGateReceipt>().stream,
      ready({
        adapterKind: "channel:test",
        names: ["turn.cancel"],
        version: CHANNEL_GATE_PROTOCOL_VERSION,
      }),
    );

    await expect(
      prepareChannelGateOperation({
        auth: null,
        gate: { adapterKind: "channel:test", names: ["session.resume"] },
        sessionId: "legacy-session",
      }),
    ).rejects.toBeInstanceOf(ChannelGateUnavailableError);
  });

  it("maps target infrastructure receipts without exposing their cause", async () => {
    const receipts = controllableStream<ChannelGateReceipt>();
    installRunStreams(receipts.stream);

    const handle = await prepareChannelGateOperation({
      auth: null,
      gate: { adapterKind: "channel:test", names: ["session.resume"] },
      sessionId: "session-1",
    });
    receipts.controller.enqueue({
      errorId: "opaque-1",
      gate: "session.resume",
      id: handle.operation.id,
      status: "unavailable",
    });

    await expect(handle.wait()).rejects.toMatchObject({
      errorId: "opaque-1",
      gate: "session.resume",
    });
  });
});

function installRunStreams(
  receiptStream: ReadableStream<ChannelGateReceipt>,
  readyStream: ReadableStream<ChannelGateReady> = ready({
    adapterKind: "channel:test",
    names: ["session.resume", "input.response", "turn.cancel", "session.reset"],
    version: CHANNEL_GATE_PROTOCOL_VERSION,
  }),
): void {
  getRunMock.mockReturnValue({
    getReadable(options: { namespace?: string; startIndex?: number } = {}) {
      if (options.namespace === CHANNEL_GATE_READY_NAMESPACE) return readyStream;
      if (
        options.namespace === CHANNEL_GATE_RECEIPT_NAMESPACE &&
        options.startIndex === undefined
      ) {
        return withTailIndex(new ReadableStream<ChannelGateReceipt>(), 3);
      }
      if (options.namespace === CHANNEL_GATE_RECEIPT_NAMESPACE && options.startIndex === 4) {
        return receiptStream;
      }
      throw new Error(`Unexpected stream request: ${JSON.stringify(options)}`);
    },
  });
}

function ready(value: ChannelGateReady): ReadableStream<ChannelGateReady> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(value);
      controller.close();
    },
  });
}

function controllableStream<T>(): {
  readonly controller: ReadableStreamDefaultController<T>;
  readonly stream: ReadableStream<T>;
} {
  let controller!: ReadableStreamDefaultController<T>;
  const stream = new ReadableStream<T>({
    start(value) {
      controller = value;
    },
  });
  return { controller, stream };
}

function withTailIndex<T>(
  stream: ReadableStream<T>,
  tailIndex: number,
): ReadableStream<T> & { getTailIndex(): Promise<number> } {
  return Object.assign(stream, {
    getTailIndex: async () => tailIndex,
  });
}
