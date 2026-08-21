import type { DurableDynamicToolMetadata } from "#context/keys.js";

export interface DurableDynamicToolCallOrigin {
  readonly authorizationAttemptIds?: readonly string[];
  readonly callId: string;
  readonly definitionId: string;
  readonly originatingStepIndex: number;
  readonly originatingTurnId: string;
  readonly toolName: string;
}

export interface DurableDynamicToolOriginState {
  readonly calls: Readonly<Record<string, DurableDynamicToolCallOrigin>>;
  readonly definitions: Readonly<Record<string, DurableDynamicToolMetadata>>;
  readonly version: 1;
}

export interface DynamicToolCallCoordinate {
  readonly callId: string;
  readonly originatingStepIndex: number;
  readonly originatingTurnId: string;
  readonly toolName: string;
}

export type DynamicToolOriginCoordinate = Pick<
  DynamicToolCallCoordinate,
  "originatingStepIndex" | "originatingTurnId"
>;

export function createDynamicToolOriginState(): DurableDynamicToolOriginState {
  return { calls: {}, definitions: {}, version: 1 };
}

export function parseDynamicToolOriginState(value: unknown): DurableDynamicToolOriginState {
  assertDynamicToolOriginState(value as DurableDynamicToolOriginState);
  return value as DurableDynamicToolOriginState;
}

export function readDynamicToolCallOrigin(
  state: DurableDynamicToolOriginState,
  callId: string,
): DurableDynamicToolCallOrigin | undefined {
  assertDynamicToolOriginState(state);
  return state.calls[callId];
}

export function readDynamicToolOriginDefinition(
  state: DurableDynamicToolOriginState,
  callId: string,
): DurableDynamicToolMetadata | undefined {
  const origin = readDynamicToolCallOrigin(state, callId);
  return origin === undefined ? undefined : state.definitions[origin.definitionId];
}

export function recordDynamicToolCallOrigin(
  state: DurableDynamicToolOriginState,
  definition: DurableDynamicToolMetadata | undefined,
  call: DynamicToolCallCoordinate,
): DurableDynamicToolOriginState {
  assertDynamicToolOriginState(state);
  if (definition === undefined) return state;
  if (call.toolName !== definition.name) {
    throw new Error(
      `Cannot record dynamic tool call "${call.callId}": tool name "${call.toolName}" does not match definition "${definition.name}".`,
    );
  }

  const existing = state.calls[call.callId];
  if (existing !== undefined) {
    if (existing.definitionId !== definition.definitionId) {
      throw new Error(
        `Dynamic tool call "${call.callId}" is already owned by definition "${existing.definitionId}".`,
      );
    }
    return state;
  }

  const origin: DurableDynamicToolCallOrigin = {
    callId: call.callId,
    definitionId: definition.definitionId,
    originatingStepIndex: call.originatingStepIndex,
    originatingTurnId: call.originatingTurnId,
    toolName: call.toolName,
  };
  return {
    calls: { ...state.calls, [call.callId]: origin },
    definitions: {
      ...state.definitions,
      [definition.definitionId]: state.definitions[definition.definitionId] ?? definition,
    },
    version: 1,
  };
}

export function addDynamicToolAuthorizationAttempts(
  state: DurableDynamicToolOriginState,
  callId: string,
  attemptIds: readonly string[],
): DurableDynamicToolOriginState {
  const origin = readDynamicToolCallOrigin(state, callId);
  if (origin === undefined) {
    throw new Error(
      `Cannot attach authorization attempts to dynamic tool call "${callId}": its origin is missing.`,
    );
  }
  const authorizationAttemptIds = [
    ...new Set([...(origin.authorizationAttemptIds ?? []), ...attemptIds]),
  ];
  if (
    authorizationAttemptIds.length === (origin.authorizationAttemptIds?.length ?? 0) &&
    authorizationAttemptIds.every((id, index) => id === origin.authorizationAttemptIds?.[index])
  ) {
    return state;
  }
  return {
    ...state,
    calls: {
      ...state.calls,
      [callId]: { ...origin, authorizationAttemptIds },
    },
  };
}

export function releaseDynamicToolCallOrigin(
  state: DurableDynamicToolOriginState,
  callId: string,
): DurableDynamicToolOriginState {
  assertDynamicToolOriginState(state);
  if (state.calls[callId] === undefined) return state;

  const calls = { ...state.calls };
  delete calls[callId];
  return collectUnreferencedDefinitions({ calls, definitions: state.definitions, version: 1 });
}

export function releaseDynamicToolCallOriginsForTurn(
  state: DurableDynamicToolOriginState,
  turnId: string,
): DurableDynamicToolOriginState {
  assertDynamicToolOriginState(state);
  const calls = Object.fromEntries(
    Object.entries(state.calls).filter(([, origin]) => origin.originatingTurnId !== turnId),
  );
  if (Object.keys(calls).length === Object.keys(state.calls).length) return state;
  return collectUnreferencedDefinitions({ calls, definitions: state.definitions, version: 1 });
}

export function reconcileDynamicToolCallOrigins(
  state: DurableDynamicToolOriginState,
  reachable: {
    readonly pendingAuthorizationAttemptIds: ReadonlySet<string>;
    readonly pendingCallIds: ReadonlySet<string>;
  },
): DurableDynamicToolOriginState {
  assertDynamicToolOriginState(state);
  const calls = Object.fromEntries(
    Object.entries(state.calls).filter(
      ([callId, origin]) =>
        reachable.pendingCallIds.has(callId) ||
        origin.authorizationAttemptIds?.some((attemptId) =>
          reachable.pendingAuthorizationAttemptIds.has(attemptId),
        ) === true,
    ),
  );
  if (Object.keys(calls).length === Object.keys(state.calls).length) return state;
  return collectUnreferencedDefinitions({ calls, definitions: state.definitions, version: 1 });
}

export function resolveDynamicToolOriginDeployment(
  state: DurableDynamicToolOriginState,
  input: {
    readonly authorizationAttemptIds: ReadonlySet<string>;
    readonly callIds: ReadonlySet<string>;
  },
): string | undefined {
  assertDynamicToolOriginState(state);
  const deployments = new Set<string>();
  let matched = false;
  for (const origin of Object.values(state.calls)) {
    const matchesCall = input.callIds.has(origin.callId);
    const matchesAuthorization = origin.authorizationAttemptIds?.some((attemptId) =>
      input.authorizationAttemptIds.has(attemptId),
    );
    if (!matchesCall && matchesAuthorization !== true) continue;

    matched = true;
    const deploymentId = state.definitions[origin.definitionId]?.runtimeDeploymentId;
    if (deploymentId === undefined) {
      throw new Error(
        `Dynamic tool call "${origin.callId}" does not record an originating deployment and cannot safely resume.`,
      );
    }
    deployments.add(deploymentId);
  }
  if (deployments.size > 1) {
    throw new Error(
      `Dynamic tool continuation spans multiple originating deployments (${[...deployments].join(", ")}). Respond to calls from one deployment at a time.`,
    );
  }
  if (!matched) return undefined;
  return deployments.values().next().value as string | undefined;
}

function collectUnreferencedDefinitions(
  state: DurableDynamicToolOriginState,
): DurableDynamicToolOriginState {
  const referenced = new Set(Object.values(state.calls).map((origin) => origin.definitionId));
  const definitions = Object.fromEntries(
    Object.entries(state.definitions).filter(([definitionId]) => referenced.has(definitionId)),
  );
  return { calls: state.calls, definitions, version: 1 };
}

function assertDynamicToolOriginState(state: DurableDynamicToolOriginState): void {
  if (typeof state !== "object" || state === null || state.version !== 1) {
    const version =
      typeof state === "object" && state !== null && "version" in state
        ? String(state.version)
        : "missing";
    throw new Error(`Unsupported dynamic tool call origin state version "${version}".`);
  }
  if (!isRecord(state.calls) || !isRecord(state.definitions)) {
    throw new Error("Dynamic tool call origin state is malformed.");
  }

  for (const [definitionId, definition] of Object.entries(state.definitions)) {
    if (
      !isRecord(definition) ||
      definition.definitionId !== definitionId ||
      typeof definition.name !== "string"
    ) {
      throw new Error(`Dynamic tool definition snapshot "${definitionId}" is malformed.`);
    }
  }
  for (const [callId, origin] of Object.entries(state.calls)) {
    if (
      !isRecord(origin) ||
      origin.callId !== callId ||
      typeof origin.definitionId !== "string" ||
      typeof origin.originatingStepIndex !== "number" ||
      !Number.isSafeInteger(origin.originatingStepIndex) ||
      origin.originatingStepIndex < 0 ||
      typeof origin.originatingTurnId !== "string" ||
      typeof origin.toolName !== "string"
    ) {
      throw new Error(`Dynamic tool call origin "${callId}" is malformed.`);
    }
    if (state.definitions[origin.definitionId] === undefined) {
      throw new Error(
        `Dynamic tool call origin "${callId}" references missing definition "${origin.definitionId}".`,
      );
    }
    if (
      origin.authorizationAttemptIds !== undefined &&
      (!Array.isArray(origin.authorizationAttemptIds) ||
        origin.authorizationAttemptIds.some((attemptId) => typeof attemptId !== "string"))
    ) {
      throw new Error(`Dynamic tool call origin "${callId}" has malformed authorization attempts.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
