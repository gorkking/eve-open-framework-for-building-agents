import { createHook, getWorkflowMetadata } from "#compiled/@workflow/core/index.js";

import type { DeliverHookPayload, SessionResetHookPayload } from "#channel/types.js";
import { ChannelGateNamesKey } from "#context/keys.js";
import { cancelDescendantTurnsStep } from "#execution/cancel-descendant-turns-step.js";
import {
  evaluateChannelDeliveryGatesStep,
  evaluateSessionResetGateStep,
  evaluateTurnCancelGateStep,
  publishChannelGateAllowStep,
} from "#execution/channel-gate-steps.js";
import { sendTurnControlStep, type TurnInboxPayload } from "#execution/turn-control-protocol.js";
import { dispatchRuntimeActionsStep } from "#execution/dispatch-runtime-actions-step.js";
import { dispatchWorkflowRuntimeActionsStep } from "#execution/dispatch-workflow-runtime-actions-step.js";
import {
  migrateTurnWorkflowInput,
  type TurnStepInput,
  type TurnWorkflowInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { claimHookOwnership, disposeHook, isHookConflictError } from "#execution/hook-ownership.js";
import type { NextDriverAction } from "#execution/next-driver-action.js";
import { routeDeliverToChildren } from "#execution/route-child-delivery.js";
import { runProxySubagentEventStep } from "#execution/subagent-event-proxy-step.js";
import {
  createTurnCancellationControl,
  type TurnCancellationControl,
} from "#execution/turn-cancellation-control.js";
import type { TurnInterruptionPayload } from "#execution/turn-cancellation-token.js";
import { TurnExecutionCursor } from "#execution/turn-execution-cursor.js";
import { resolveWorkflowCallbackBaseUrl } from "#execution/workflow-callback-url.js";
import { normalizeSerializableError } from "#execution/workflow-errors.js";
import { turnStep } from "#execution/workflow-steps.js";
import { activeTurnId } from "#harness/active-turn-id.js";
import { resolveRuntimeActionResultsForKeys } from "#harness/runtime-actions.js";
import type { RuntimeActionResult } from "#runtime/actions/types.js";

const TASK_MODE_WAIT_ERROR_MESSAGE = "Task mode cannot wait for follow-up input (`next: null`).";

// A cancelled turn settles by parking the session, so the cancel hook is
// only claimed where a park can land: conversation sessions always accept
// follow-up input, and task sessions can park only when a continuation
// token anchors them to a waiting parent (delegated subagents always have
// one). A root task run without one is unparkable, so it stays
// uncancellable rather than settling a cancel as `session.failed`.
function canSettleCancelledTurnAsPark(input: TurnWorkflowInput): boolean {
  return input.mode === "conversation" || input.stepInput.sessionState.continuationToken !== "";
}

export type { TurnWorkflowInput };

/**
 * Runs one complete logical turn, including child-agent waits when supported.
 *
 * The turn-owned path also owns turn cancellation: resuming the
 * session-scoped cancel hook (`{sessionId}:cancel`) mid-turn aborts the
 * signal serialized into every `turnStep` and settles the turn as
 * `turn.cancelled` → `session.waiting` — never as a failure. A late or
 * guard-mismatched cancel is a benign no-op.
 */
export async function turnWorkflow(rawInput: unknown): Promise<void> {
  "use workflow";

  const input = migrateTurnWorkflowInput(rawInput);

  if (input.driverCapabilities?.turnInbox !== true) {
    return runLegacyTurnWorkflow(input);
  }

  return runTurnOwnedWorkflow(input);
}

async function runTurnOwnedWorkflow(input: TurnWorkflowInput): Promise<void> {
  const inbox = createHook<TurnInboxPayload>({ token: `${input.completionToken}:inbox` });
  // Hook promises and iterators share one durable cursor. Create the iterator before
  // claiming so conflict replay is consumed by getConflict(), not a later iterator read.
  const iterator = inbox[Symbol.asyncIterator]();
  const cursor = new TurnExecutionCursor({
    controlToken: input.completionToken,
    ...(input.gateReceiptWritable === undefined
      ? {}
      : { gateReceiptWritable: input.gateReceiptWritable }),
    parentWritable: input.stepInput.parentWritable,
    serializedContext: input.stepInput.serializedContext,
    sessionState: input.stepInput.sessionState,
  });
  // Delivery request ids stay unique across every wait in this turn. A forwarded
  // delivery left unconsumed when one wait resolves would otherwise reuse a later
  // wait's id and be mis-accepted as that wait's response.
  let deliveryRequestSeq = 0;
  const nextDeliveryRequestId = (): string =>
    `${inbox.token}:delivery:${String(deliveryRequestSeq++)}`;
  const bufferedDeliveries: DeliverHookPayload[] = [];
  let nextStepInput = input.stepInput.input;
  let ownsInbox = false;
  let cancellation: TurnCancellationControl | undefined;

  try {
    if (nextStepInput?.kind === "session-reset") {
      await handleParkedReset({ cursor, reset: nextStepInput });
      return;
    }

    try {
      await claimHookOwnership(inbox);
      ownsInbox = true;
    } catch (error) {
      if (isHookConflictError(error)) return;
      throw error;
    }

    // Claimed after the inbox claim so a losing duplicate run never
    // contends for the session cancel token.
    const canCancel =
      input.driverCapabilities?.cancelledTurnSettle === true && canSettleCancelledTurnAsPark(input);
    const acceptsReset = configuredGateNames(input).includes("session.reset");
    if (canCancel || acceptsReset) {
      cancellation = await createTurnCancellationControl({
        acceptReset: acceptsReset,
        authorize: async (payload, available) =>
          await authorizeInterruption({
            available,
            cursor,
            payload,
          }),
        canCancel,
        expectedTurnId: activeTurnId(input.stepInput.sessionState.emissionState),
        sessionId: input.stepInput.sessionState.sessionId,
      });
    }

    if (nextStepInput?.kind === "deliver") {
      const prepared = await prepareDelivery({ cursor, delivery: nextStepInput });
      if (prepared.kind === "block") {
        await finishUnchangedPark(cursor);
        return;
      }
      if (prepared.kind === "cancel-turn") {
        await finishCancelledTurn({ bufferedDeliveries, cancellation, cursor });
        return;
      }
      if (prepared.kind === "routed") {
        await finishUnchangedPark(cursor);
        return;
      }
      nextStepInput = prepared.delivery;
    }

    while (true) {
      const result = await turnStep(cursor.createStepInput(nextStepInput, cancellation?.signal));

      if (result.action === "cancelled") {
        // No `canPark` check here: that gate rejects model-authored waits
        // (`next: null`) in task mode, whereas a cancelled turn parks by
        // design and its parkability was already established when the
        // cancel hook was claimed (`canSettleCancelledTurnAsPark`). The
        // epilogue runs in the driver (`settleCancelledTurnStep`), not as
        // a step in this run, where queued cancel wakes could re-dispatch
        // it.
        await finishInterruption({
          bufferedDeliveries,
          cancellation,
          cursor,
          kind: cancellation?.signal.aborted === true ? await cancellation.requested : "cancel",
        });
        return;
      }

      if (result.action === "done") {
        if (cancellation?.signal.aborted === true) {
          await finishInterruption({
            bufferedDeliveries,
            cancellation,
            cursor,
            kind: await cancellation.requested,
          });
          return;
        }
        await cancellation?.dispose();
        await cursor.finish(
          result,
          {
            kind: "done",
            output: result.output ?? "",
            isError: result.isError,
            usage: result.usage,
          },
          bufferedDeliveries,
        );
        return;
      }

      // A pending runtime-action batch (model-driven `park` or dynamic-workflow
      // interrupt) is resolved in-line so the turn stays alive across the wait;
      // the two arms differ only in their dispatch path.
      const pendingActionKeys =
        result.action === "dispatch-workflow-runtime-actions" || result.action === "park"
          ? result.pendingRuntimeActionKeys
          : undefined;

      if (pendingActionKeys !== undefined) {
        await cursor.adopt(result);
        const dispatch =
          result.action === "dispatch-workflow-runtime-actions"
            ? dispatchWorkflowRuntimeActionsStep
            : dispatchRuntimeActionsStep;
        const dispatchResult = await dispatch({
          callbackBaseUrl: resolveWorkflowCallbackBaseUrl(getWorkflowMetadata().url),
          parentContinuationToken: inbox.token,
          parentWritable: cursor.parentWritable,
          serializedContext: cursor.serializedContext,
          sessionState: cursor.sessionState,
        });
        await cursor.adopt(dispatchResult);

        const results = await waitForRuntimeActionResults({
          bufferedDeliveries,
          cancellation,
          cursor,
          inboxToken: inbox.token,
          initialResults: dispatchResult.results,
          iterator,
          nextDeliveryRequestId,
          pendingActionKeys,
        });
        if (results === "cancelled") {
          // The next turnStep observes the aborted signal and settles
          // through the `cancelled` arm above.
          nextStepInput = undefined;
          continue;
        }
        if (results === "cancel-turn") {
          await finishCancelledTurn({ bufferedDeliveries, cancellation, cursor });
          return;
        }
        if (results === "reset") {
          await finishResetTurn({ bufferedDeliveries, cancellation, cursor });
          return;
        }
        nextStepInput = { kind: "runtime-action-result", results };
        continue;
      }

      if (result.action === "park") {
        const canPark =
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
          input.mode === "conversation";

        if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);

        await cancellation?.dispose();
        await cursor.finish(
          result,
          {
            authorizationNames: result.authorizationNames,
            kind: "park",
          },
          bufferedDeliveries,
        );
        return;
      }

      await cursor.adopt(result);
      nextStepInput = undefined;
    }
  } catch (error) {
    await cursor.send({ error: normalizeSerializableError(error), kind: "turn-error" });
    throw error;
  } finally {
    // Dispose-only teardown: `iterator.return()` would await a pending
    // durable read that never settles, leaving this run `running` forever
    // and its hooks unswept. The cancel token is disposed *before* each
    // terminal result publishes so the next turn's claim never races this
    // run's teardown; this backstop covers the error path.
    if (cancellation !== undefined) await cancellation.dispose();
    if (ownsInbox) await disposeHook(inbox);
  }
}

type PreparedDelivery =
  | { readonly kind: "block" }
  | { readonly kind: "cancel-turn" }
  | { readonly kind: "routed" }
  | { readonly delivery: DeliverHookPayload; readonly kind: "delivery" };

async function prepareDelivery(input: {
  readonly cursor: TurnExecutionCursor;
  readonly delivery: DeliverHookPayload;
}): Promise<PreparedDelivery> {
  const operation = input.delivery.gateOperation;
  if (operation !== undefined) {
    const evaluation = await evaluateChannelDeliveryGatesStep({
      delivery: input.delivery,
      operation,
      receiptWritable: input.cursor.gateReceiptWritable,
      serializedContext: input.cursor.serializedContext,
      sessionState: input.cursor.sessionState,
    });
    if (evaluation.status === "block") return { kind: "block" };
  }

  if (!input.cursor.sessionState.hasProxyInputRequests) {
    await acknowledgeAllowedOperation(input.cursor, operation?.id);
    return {
      delivery: {
        auth: input.delivery.auth,
        kind: "deliver",
        payloads: input.delivery.payloads,
        requestId: input.delivery.requestId,
      },
      kind: "delivery",
    };
  }

  const routed = await routeDeliverToChildren({
    auth: input.delivery.auth,
    parentWritable: input.cursor.parentWritable,
    payloads: input.delivery.payloads,
    sessionState: input.cursor.sessionState,
  });
  await acknowledgeAllowedOperation(input.cursor, operation?.id);
  if (routed.kind === "cancel-turn") return routed;
  if (routed.remainder === undefined) return { kind: "routed" };

  const delivery: DeliverHookPayload = {
    auth: input.delivery.auth,
    kind: "deliver",
    payloads: [routed.remainder],
    requestId: input.delivery.requestId,
  };
  return { delivery, kind: "delivery" };
}

async function handleParkedReset(input: {
  readonly cursor: TurnExecutionCursor;
  readonly reset: SessionResetHookPayload;
}): Promise<void> {
  const evaluation = await evaluateSessionResetGateStep({
    continuationToken: input.reset.continuationToken,
    operation: input.reset.gateOperation,
    reason: input.reset.reason,
    receiptWritable: input.cursor.gateReceiptWritable,
    serializedContext: input.cursor.serializedContext,
    sessionState: input.cursor.sessionState,
  });
  if (evaluation.status === "allow") {
    await acknowledgeAllowedOperation(input.cursor, input.reset.gateOperation.id);
    await finishResetTurn({ cancellation: undefined, cursor: input.cursor });
  } else {
    await finishUnchangedPark(input.cursor);
  }
}

async function authorizeInterruption(input: {
  readonly available: boolean;
  readonly cursor: TurnExecutionCursor;
  readonly payload: TurnInterruptionPayload;
}): Promise<boolean> {
  const operation = input.payload.gateOperation;
  if (operation === undefined) return false;

  const common = {
    operation,
    receiptWritable: input.cursor.gateReceiptWritable,
    serializedContext: input.cursor.serializedContext,
    sessionState: input.cursor.sessionState,
  };
  const evaluation =
    input.payload.kind === "reset"
      ? await evaluateSessionResetGateStep({
          ...common,
          continuationToken: input.payload.continuationToken,
          reason: input.payload.reason,
        })
      : await evaluateTurnCancelGateStep({
          ...common,
          available: input.available,
          continuationToken: input.payload.continuationToken,
          turnId: input.payload.turnId,
        });
  if (evaluation.status !== "allow") return false;
  await acknowledgeAllowedOperation(input.cursor, operation.id);
  return true;
}

async function acknowledgeAllowedOperation(
  cursor: TurnExecutionCursor,
  operationId: string | undefined,
): Promise<void> {
  if (operationId === undefined) return;
  await publishChannelGateAllowStep({
    id: operationId,
    writable: cursor.gateReceiptWritable,
  });
}

function configuredGateNames(input: TurnWorkflowInput): readonly string[] {
  const names = input.stepInput.serializedContext[ChannelGateNamesKey.name];
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : [];
}

async function finishInterruption(input: {
  readonly bufferedDeliveries: readonly DeliverHookPayload[];
  readonly cancellation: TurnCancellationControl | undefined;
  readonly cursor: TurnExecutionCursor;
  readonly kind: "cancel" | "reset";
}): Promise<void> {
  if (input.kind === "reset") {
    await finishResetTurn(input);
  } else {
    await finishCancelledTurn(input);
  }
}

async function finishUnchangedPark(cursor: TurnExecutionCursor): Promise<void> {
  await cursor.finish(
    {
      serializedContext: cursor.serializedContext,
      sessionState: cursor.sessionState,
    },
    { kind: "park" },
    [],
  );
}

async function finishResetTurn(input: {
  readonly bufferedDeliveries?: readonly DeliverHookPayload[];
  readonly cancellation: TurnCancellationControl | undefined;
  readonly cursor: TurnExecutionCursor;
}): Promise<void> {
  await cancelDescendantTurnsStep({
    serializedContext: input.cursor.serializedContext,
    sessionState: input.cursor.sessionState,
  });
  await input.cancellation?.dispose();
  await input.cursor.finish(
    { sessionState: input.cursor.sessionState },
    { kind: "park", reset: true },
    [],
  );
}

async function finishCancelledTurn(input: {
  readonly bufferedDeliveries: readonly DeliverHookPayload[];
  readonly cancellation: TurnCancellationControl | undefined;
  readonly cursor: TurnExecutionCursor;
}): Promise<void> {
  await cancelDescendantTurnsStep({
    serializedContext: input.cursor.serializedContext,
    sessionState: input.cursor.sessionState,
  });
  await input.cancellation?.dispose();
  await input.cursor.finish(
    { sessionState: input.cursor.sessionState },
    { cancelled: true, kind: "park" },
    input.bufferedDeliveries,
  );
}

// These sentinels stay outside `RuntimeActionResult`. That union is the
// schema-validated wire type projected into harness resume calls; these are
// turn-workflow control outcomes that never leave the workflow.
async function waitForRuntimeActionResults(input: {
  readonly bufferedDeliveries: DeliverHookPayload[];
  readonly cancellation: TurnCancellationControl | undefined;
  readonly cursor: TurnExecutionCursor;
  readonly inboxToken: string;
  readonly initialResults: readonly RuntimeActionResult[];
  readonly iterator: AsyncIterator<TurnInboxPayload>;
  readonly nextDeliveryRequestId: () => string;
  readonly pendingActionKeys: readonly string[];
}): Promise<readonly RuntimeActionResult[] | "cancelled" | "cancel-turn" | "reset"> {
  let pendingDeliveryRequest: string | undefined;
  const results: RuntimeActionResult[] = [...input.initialResults];

  while (true) {
    const ready = resolveRuntimeActionResultsForKeys({
      pendingKeys: input.pendingActionKeys,
      results,
    });
    if (ready !== undefined) {
      if (pendingDeliveryRequest !== undefined) {
        // The entry may already be racing public input against this wait.
        // Cancellation keeps that input available for the next parent turn.
        await input.cursor.send({
          kind: "turn-delivery-cancelled",
          requestId: pendingDeliveryRequest,
        });
      }
      return ready;
    }

    if (input.cursor.sessionState.hasProxyInputRequests && pendingDeliveryRequest === undefined) {
      pendingDeliveryRequest = input.nextDeliveryRequestId();
      await input.cursor.send({
        continuationToken: input.cursor.sessionState.continuationToken,
        inboxToken: input.inboxToken,
        kind: "turn-delivery-request",
        requestId: pendingDeliveryRequest,
      });
    }

    const nextPromise = input.iterator.next();
    // When a cancel wins the race, the dangling inbox `next()` is dropped
    // by disposal in teardown; pre-attach a handler so a late rejection
    // never surfaces as unhandled.
    nextPromise.catch(() => {});
    const next = await (input.cancellation === undefined
      ? nextPromise
      : Promise.race([nextPromise, input.cancellation.requested]));
    if (next === "cancel") {
      if (pendingDeliveryRequest !== undefined) {
        // Release the raced public input back to the driver so it stays
        // available for the next turn.
        await input.cursor.send({
          kind: "turn-delivery-cancelled",
          requestId: pendingDeliveryRequest,
        });
      }
      return "cancelled";
    }
    if (next === "reset") {
      if (pendingDeliveryRequest !== undefined) {
        await input.cursor.send({
          kind: "turn-delivery-cancelled",
          requestId: pendingDeliveryRequest,
        });
      }
      return "reset";
    }
    if (next.done) throw new Error("Turn inbox closed before runtime actions completed.");

    const value = next.value;
    if (value.kind === "runtime-action-result") {
      results.push(...value.results);
      continue;
    }

    if (value.kind === "subagent-input-request" || value.kind === "subagent-authorization-event") {
      const proxyResult = await runProxySubagentEventStep({
        hookPayload: value,
        parentWritable: input.cursor.parentWritable,
        serializedContext: input.cursor.serializedContext,
        sessionState: input.cursor.sessionState,
      });
      await input.cursor.adopt(proxyResult);
      continue;
    }

    // Only `driver-delivery` reaches the inbox for public input: children
    // resume it with results/HITL, and the driver relays public deliveries
    // through the request handshake. A stale, non-matching request id means
    // the turn already resolved and the driver re-buffered the delivery.
    if (value.kind === "driver-delivery" && value.requestId === pendingDeliveryRequest) {
      await input.cursor.send({ kind: "turn-delivery-accepted", requestId: value.requestId });
      pendingDeliveryRequest = undefined;

      const prepared = await prepareDelivery({
        cursor: input.cursor,
        delivery: value.delivery,
      });
      if (prepared.kind === "cancel-turn") return prepared.kind;
      if (prepared.kind === "delivery") {
        input.bufferedDeliveries.push(prepared.delivery);
      }
    }
  }
}

async function runLegacyTurnWorkflow(input: TurnWorkflowInput): Promise<void> {
  let currentStepInput: TurnStepInput = input.stepInput;

  try {
    while (true) {
      const result = await turnStep(currentStepInput);

      if (result.action === "done") {
        await sendTurnControlStep({
          controlToken: input.completionToken,
          payload: {
            action: {
              kind: "done",
              output: result.output ?? "",
              isError: result.isError,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
              usage: result.usage,
            },
            kind: "turn-result",
          },
        });
        return;
      }

      if (result.action === "dispatch-workflow-runtime-actions") {
        await sendTurnControlStep({
          controlToken: input.completionToken,
          payload: {
            action: {
              kind: "dispatch-workflow-runtime-actions",
              pendingActionKeys: result.pendingRuntimeActionKeys,
              serializedContext: result.serializedContext,
              sessionState: result.sessionState,
            },
            kind: "turn-result",
          },
        });
        return;
      }

      if (result.action === "park") {
        const pendingActionKeys = result.pendingRuntimeActionKeys;
        const canPark =
          pendingActionKeys !== undefined ||
          result.hasPendingAuthorization ||
          (result.hasPendingInputBatch && input.capabilities?.requestInput === true) ||
          input.mode === "conversation";

        if (!canPark) throw new Error(TASK_MODE_WAIT_ERROR_MESSAGE);

        const action: NextDriverAction =
          pendingActionKeys !== undefined
            ? {
                kind: "dispatch-runtime-actions",
                pendingActionKeys,
                serializedContext: result.serializedContext,
                sessionState: result.sessionState,
              }
            : {
                kind: "park",
                serializedContext: result.serializedContext,
                sessionState: result.sessionState,
                authorizationNames: result.authorizationNames,
              };

        await sendTurnControlStep({
          controlToken: input.completionToken,
          payload: { action, kind: "turn-result" },
        });
        return;
      }

      currentStepInput = {
        input: undefined,
        parentWritable: currentStepInput.parentWritable,
        serializedContext: result.serializedContext,
        sessionState: result.sessionState,
      };
    }
  } catch (error) {
    await sendTurnControlStep({
      controlToken: input.completionToken,
      payload: { error: normalizeSerializableError(error), kind: "turn-error" },
    });
    throw error;
  }
}
