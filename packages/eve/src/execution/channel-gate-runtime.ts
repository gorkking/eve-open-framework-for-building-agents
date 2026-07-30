import { ChannelGateDeniedError, ChannelGateUnavailableError } from "#channel/gate-errors.js";
import type {
  ChannelGateOperation,
  ChannelGateReceipt,
  ChannelGateRequest,
  SessionAuthContext,
} from "#channel/types.js";
import {
  CHANNEL_GATE_PROTOCOL_VERSION,
  CHANNEL_GATE_READY_NAMESPACE,
  CHANNEL_GATE_RECEIPT_NAMESPACE,
  type ChannelGateReady,
} from "#execution/channel-gate-protocol.js";
import { getRun } from "#internal/workflow/runtime.js";
import { createLogger, logError } from "#internal/logging.js";

const READY_READ_TIMEOUT_MS = 5_000;
const log = createLogger("channel.gate");

/** Prepared receipt cursor opened before an operation is committed to a session hook. */
export interface ChannelGateOperationHandle {
  readonly operation: ChannelGateOperation;
  cancel(): Promise<void>;
  wait(): Promise<"allow" | "no_active_session">;
}

/** Verifies target support and opens a receipt cursor before sending an operation. */
export async function prepareChannelGateOperation(input: {
  readonly auth: SessionAuthContext | null;
  readonly gate: ChannelGateRequest;
  readonly sessionId: string;
}): Promise<ChannelGateOperationHandle> {
  await assertGateProtocolReady(input);

  const operation: ChannelGateOperation = {
    ...input.gate,
    auth: input.auth,
    id: crypto.randomUUID(),
  };
  const run = getRun(input.sessionId);
  const tailReadable = run.getReadable<ChannelGateReceipt>({
    namespace: CHANNEL_GATE_RECEIPT_NAMESPACE,
  });
  let tailIndex: number;
  try {
    tailIndex = await tailReadable.getTailIndex();
  } finally {
    await tailReadable.cancel("channel gate receipt tail resolved").catch(() => {});
  }

  const reader = run
    .getReadable<ChannelGateReceipt>({
      namespace: CHANNEL_GATE_RECEIPT_NAMESPACE,
      startIndex: tailIndex + 1,
    })
    .getReader();
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await reader.cancel("channel gate receipt resolved").catch(() => {});
    reader.releaseLock();
  };

  return {
    operation,
    cancel: close,
    async wait(): Promise<"allow" | "no_active_session"> {
      try {
        while (true) {
          const next = await reader.read();
          if (next.done) {
            throw unavailable(
              input.gate.names[0] ?? "session.resume",
              new Error("The target session ended before acknowledging its gate operation."),
            );
          }
          if (next.value.id !== operation.id) continue;
          if (next.value.status === "allow" || next.value.status === "no_active_session") {
            return next.value.status;
          }
          if (next.value.status === "denied") {
            throw new ChannelGateDeniedError(next.value.gate, next.value.reason);
          }
          throw new ChannelGateUnavailableError(next.value.gate, {
            errorId: next.value.errorId,
          });
        }
      } finally {
        await close();
      }
    },
  };
}

async function assertGateProtocolReady(input: {
  readonly gate: ChannelGateRequest;
  readonly sessionId: string;
}): Promise<void> {
  const firstGate = input.gate.names[0] ?? "session.resume";
  let readable;
  try {
    readable = getRun(input.sessionId).getReadable<ChannelGateReady>({
      namespace: CHANNEL_GATE_READY_NAMESPACE,
      startIndex: -1,
    });
  } catch (error) {
    throw unavailable(firstGate, error);
  }

  const reader = readable.getReader();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<undefined>((resolve) => {
        timeout = setTimeout(() => resolve(undefined), READY_READ_TIMEOUT_MS);
      }),
    ]);
    if (
      result === undefined ||
      result.done ||
      result.value.version !== CHANNEL_GATE_PROTOCOL_VERSION ||
      result.value.adapterKind !== input.gate.adapterKind ||
      input.gate.names.some((name) => !result.value.names.includes(name))
    ) {
      throw unavailable(
        firstGate,
        new Error(`Session "${input.sessionId}" does not support the requested channel gates.`),
      );
    }
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
    await reader.cancel("channel gate readiness resolved").catch(() => {});
    reader.releaseLock();
  }
}

function unavailable(
  gate: ChannelGateRequest["names"][number],
  error: unknown,
): ChannelGateUnavailableError {
  if (error instanceof ChannelGateUnavailableError) return error;
  const errorId = logError(log, "channel gate protocol unavailable", error, { gate });
  return new ChannelGateUnavailableError(gate, { errorId });
}
