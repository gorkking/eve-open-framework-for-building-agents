import type { ModelMessage } from "ai";

import type { AlsContext } from "#context/container.js";
import { contextStorage } from "#context/container.js";
import type { ContextReader } from "#context/key.js";
import {
  DynamicToolCallCoordinateKey,
  DynamicToolCallOriginsKey,
  SessionKey,
  type DurableDynamicToolMetadata,
} from "#context/keys.js";
import { getPendingAuthorization } from "#harness/authorization.js";
import {
  addDynamicToolAuthorizationAttempts,
  createDynamicToolOriginState,
  readDynamicToolCallOrigin,
  readDynamicToolOriginDefinition,
  reconcileDynamicToolCallOrigins,
  recordDynamicToolCallOrigin,
  releaseDynamicToolCallOrigin,
  releaseDynamicToolCallOriginsForTurn,
  type DurableDynamicToolOriginState,
} from "#harness/dynamic-tool-call-origins.js";
import { getPendingInputBatches } from "#harness/pending-input-batches.js";
import type { SessionStateMap } from "#harness/types.js";

export function resolveDynamicToolMetadataForCall(input: {
  readonly callId: string;
  readonly current?: DurableDynamicToolMetadata;
  readonly knownCall: boolean;
  readonly toolName: string;
}): DurableDynamicToolMetadata | undefined {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) return input.current;

  const state = readOriginState(ctx);
  const origin = readDynamicToolCallOrigin(state, input.callId);
  if (origin !== undefined) {
    if (origin.toolName !== input.toolName) {
      throw new Error(
        `Dynamic tool call "${input.callId}" originated as "${origin.toolName}", not "${input.toolName}".`,
      );
    }
    return readDynamicToolOriginDefinition(state, input.callId)!;
  }
  if (input.current === undefined) return undefined;
  if (input.knownCall) {
    throw new Error(
      `Dynamic tool call "${input.callId}" is pending, but its originating definition is missing. The call cannot safely resume.`,
    );
  }

  const session = ctx.get(SessionKey);
  const coordinate = ctx.get(DynamicToolCallCoordinateKey) ?? {
    originatingStepIndex: 0,
    originatingTurnId: session?.turn.id ?? "turn_unknown",
  };
  writeOriginState(
    ctx,
    recordDynamicToolCallOrigin(state, input.current, {
      callId: input.callId,
      ...coordinate,
      toolName: input.toolName,
    }),
  );
  return input.current;
}

export function hasDynamicToolCallInMessages(
  messages: readonly ModelMessage[] | undefined,
  callId: string,
): boolean {
  for (const message of messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (
        typeof part === "object" &&
        part !== null &&
        "toolCallId" in part &&
        part.toolCallId === callId
      ) {
        return true;
      }
    }
  }
  return false;
}

export function addAuthorizationAttemptsForDynamicToolCall(
  callId: string,
  attemptIds: readonly string[],
): void {
  if (attemptIds.length === 0) return;
  const ctx = contextStorage.getStore();
  if (ctx === undefined || ctx.get(DynamicToolCallOriginsKey) === undefined) return;
  writeOriginState(
    ctx,
    addDynamicToolAuthorizationAttempts(readOriginState(ctx), callId, attemptIds),
  );
}

export function releaseDynamicToolCallOrigins(callIds: Iterable<string>): void {
  const ctx = contextStorage.getStore();
  if (ctx === undefined || ctx.get(DynamicToolCallOriginsKey) === undefined) return;
  let state = readOriginState(ctx);
  for (const callId of callIds) state = releaseDynamicToolCallOrigin(state, callId);
  writeOriginState(ctx, state);
}

export function releaseCurrentDynamicToolOriginsForTurn(turnId: string): void {
  const ctx = contextStorage.getStore();
  if (ctx === undefined) return;
  releaseDynamicToolOriginsForTurn(ctx, turnId);
}

export function releaseDynamicToolOriginsForTurn(ctx: AlsContext, turnId: string): void {
  if (ctx.get(DynamicToolCallOriginsKey) === undefined) return;
  writeOriginState(ctx, releaseDynamicToolCallOriginsForTurn(readOriginState(ctx), turnId));
}

export function clearDynamicToolCallOrigins(ctx: AlsContext): void {
  ctx.delete(DynamicToolCallOriginsKey);
}

export function reconcileDynamicToolOrigins(
  ctx: AlsContext,
  sessionState: SessionStateMap | undefined,
): void {
  if (ctx.get(DynamicToolCallOriginsKey) === undefined) return;
  const pendingCallIds = new Set(
    getPendingInputBatches(sessionState).flatMap((batch) =>
      batch.requests.map((request) => request.action.callId),
    ),
  );
  const pendingAuthorizationAttemptIds = new Set(
    getPendingAuthorization(sessionState)?.challenges.flatMap((challenge) =>
      challenge.attemptId === undefined ? [] : [challenge.attemptId],
    ) ?? [],
  );
  writeOriginState(
    ctx,
    reconcileDynamicToolCallOrigins(readOriginState(ctx), {
      pendingAuthorizationAttemptIds,
      pendingCallIds,
    }),
  );
}

export function readArchivedDynamicToolDefinitions(
  ctx: ContextReader,
): readonly DurableDynamicToolMetadata[] {
  const state = ctx.get(DynamicToolCallOriginsKey);
  if (state === undefined) return [];
  readDynamicToolCallOrigin(state, "");
  return Object.values(state.definitions);
}

function readOriginState(ctx: AlsContext): DurableDynamicToolOriginState {
  const state = ctx.get(DynamicToolCallOriginsKey) ?? createDynamicToolOriginState();
  readDynamicToolCallOrigin(state, "");
  return state;
}

function writeOriginState(ctx: AlsContext, state: DurableDynamicToolOriginState): void {
  if (Object.keys(state.calls).length === 0) {
    ctx.delete(DynamicToolCallOriginsKey);
  } else {
    ctx.set(DynamicToolCallOriginsKey, state);
  }
}
