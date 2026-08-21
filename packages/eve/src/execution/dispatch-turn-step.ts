import {
  createTurnWorkflowInput,
  type TurnWorkflowDispatchInput,
} from "#execution/durable-session-migrations/turn-workflow.js";
import { buildTurnAttributes, readRootSessionId } from "#execution/eve-workflow-attributes.js";
import { startWorkflowPreferLatest, turnWorkflowReference } from "#execution/workflow-runtime.js";
import { start } from "#internal/workflow/runtime.js";
import { normalizeEveAttributes } from "#runtime/attributes/normalize.js";
import { DynamicToolCallOriginsKey } from "#context/keys.js";
import {
  parseDynamicToolOriginState,
  resolveDynamicToolOriginDeployment,
} from "#harness/dynamic-tool-call-origins.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";

/** Starts a per-turn child workflow for the current driver session. */
export async function dispatchTurnStep(
  input: TurnWorkflowDispatchInput,
): Promise<{ readonly runId: string }> {
  "use step";

  const args: Parameters<typeof startWorkflowPreferLatest>[1] = [createTurnWorkflowInput(input)];
  const options = {
    allowReservedAttributes: true,
    attributes: normalizeEveAttributes(
      buildTurnAttributes({
        parentSessionId: input.sessionState.sessionId,
        requestId: input.delivery.kind === "deliver" ? input.delivery.requestId : undefined,
        rootSessionId: readRootSessionId(input.serializedContext) ?? input.sessionState.sessionId,
      }),
    ),
  };
  const originDeploymentId = resolveOriginDeploymentForDelivery(input);
  const run =
    originDeploymentId === undefined
      ? await startWorkflowPreferLatest(turnWorkflowReference, args, options)
      : await start(turnWorkflowReference, args, {
          ...options,
          deploymentId: originDeploymentId,
        });

  return { runId: run.runId };
}

function resolveOriginDeploymentForDelivery(input: TurnWorkflowDispatchInput): string | undefined {
  if (input.delivery.kind !== "deliver") return undefined;
  const rawOrigins = input.serializedContext[DynamicToolCallOriginsKey.name];
  if (rawOrigins === undefined) return undefined;

  const requestIds = new Set<string>();
  const authorizationAttemptIds = new Set<string>();
  for (const payload of input.delivery.payloads) {
    for (const response of payload.inputResponses ?? []) requestIds.add(response.requestId);
    const callback = payload["authorizationCallback"] as
      | {
          readonly attemptId?: unknown;
          readonly connectionName?: unknown;
          readonly legacy?: unknown;
        }
      | undefined;
    const authorizationId =
      typeof callback?.attemptId === "string"
        ? callback.attemptId
        : callback?.legacy === true && typeof callback.connectionName === "string"
          ? callback.connectionName
          : undefined;
    if (authorizationId !== undefined) authorizationAttemptIds.add(authorizationId);
  }

  const callIds = new Set(
    getPendingInputBatches(input.sessionState.snapshot?.session.state).flatMap((batch) =>
      batch.requests
        .filter((request) => requestIds.has(request.requestId))
        .map((request) => request.action.callId),
    ),
  );
  if (callIds.size === 0 && authorizationAttemptIds.size === 0) return undefined;

  return resolveDynamicToolOriginDeployment(parseDynamicToolOriginState(rawOrigins), {
    authorizationAttemptIds,
    callIds,
  });
}
