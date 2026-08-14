import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { getMemoryProjection } from "#harness/memory-state.js";
import type { DurableMemoryCallbackSession } from "#harness/memory-state.js";
import type { HarnessSession } from "#harness/types.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type {
  MemoryOperationContext,
  MemoryProjection,
  MemoryScope,
  MemoryToolsContext,
  MemoryTurnContext,
} from "#public/memory/index.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";

const MEMORY_OPERATION_DOMAIN = "eve-memory-operation-v1";

export type MemoryOperationPhase =
  | "compaction.completed"
  | "compaction.requested"
  | "step.started"
  | "turn.completed"
  | "turn.started";

/** Content-free framework error for one failed provider invocation. */
export class MemoryOperationError extends Error {
  readonly operationId: string;
  readonly phase: MemoryOperationPhase;
  readonly slot: string;

  constructor(input: {
    readonly cause: unknown;
    readonly operationId: string;
    readonly phase: MemoryOperationPhase;
    readonly slot: string;
  }) {
    super(`Memory provider "${input.slot}" failed during ${input.phase}.`, {
      cause: input.cause,
    });
    this.name = "MemoryOperationError";
    this.operationId = input.operationId;
    this.phase = input.phase;
    this.slot = input.slot;
  }
}

export function createOperationContext(input: {
  readonly abortSignal: AbortSignal;
  readonly callbackSession: DurableMemoryCallbackSession;
  readonly messages: readonly ModelMessage[];
  readonly operationId: string;
  readonly scope: MemoryScope;
  readonly session: HarnessSession;
  readonly slot: string;
  readonly current?: MemoryProjection | null;
}): MemoryOperationContext {
  return {
    ...restoreCallbackContext(input.callbackSession),
    abortSignal: input.abortSignal,
    memory: {
      current:
        input.current === undefined
          ? getMemoryProjection({ scope: input.scope, session: input.session, slot: input.slot })
          : cloneProjection(input.current),
      scope: cloneScope(input.scope),
      slot: input.slot,
    },
    messages: [...input.messages],
    operationId: input.operationId,
  };
}

export function createToolsContext(input: {
  readonly abortSignal: AbortSignal;
  readonly callbackSession: DurableMemoryCallbackSession;
  readonly current?: MemoryProjection | null;
  readonly messages: readonly ModelMessage[];
  readonly modelId: string;
  readonly operationId: string;
  readonly scope: MemoryScope;
  readonly session: HarnessSession;
  readonly slot: string;
  readonly stepIndex: number;
  readonly turn: MemoryTurnContext;
}): MemoryToolsContext {
  return {
    ...createOperationContext(input),
    phase: "step.started",
    step: { modelId: input.modelId, stepIndex: input.stepIndex },
    turn: cloneTurn(input.turn),
  };
}

export function captureCallbackSession(
  callback: SessionContext,
  turn: MemoryTurnContext | null,
): DurableMemoryCallbackSession {
  return {
    auth: callback.session.auth,
    id: callback.session.id,
    parent: callback.session.parent,
    turn: turn === null ? callback.session.turn : { id: turn.turnId, sequence: turn.sequence },
  };
}

export function cloneTurn(turn: MemoryTurnContext): MemoryTurnContext {
  return { input: [...turn.input], sequence: turn.sequence, turnId: turn.turnId };
}

export function cloneScope(scope: MemoryScope): MemoryScope {
  return { key: scope.key, parts: [...scope.parts] };
}

export function cloneProjection(projection: MemoryProjection | null): MemoryProjection | null {
  return projection === null ? null : { content: projection.content };
}

export function principalIdentity(principal: SessionAuthContext | null): string {
  return JSON.stringify(
    principal === null
      ? null
      : [
          principal.principalType,
          principal.authenticator,
          principal.issuer ?? null,
          principal.principalId,
        ],
  );
}

export function requireMemory(
  memories: readonly ResolvedMemoryDefinition[],
  slot: string,
): ResolvedMemoryDefinition {
  const memory = memories.find((candidate) => candidate.slot === slot);
  if (memory === undefined) {
    throw new Error(`Memory slot "${slot}" is unavailable in the active runtime revision.`);
  }
  return memory;
}

export function resolveAbortSignal(signal: AbortSignal | undefined): AbortSignal {
  return signal ?? new AbortController().signal;
}

export function createMemoryOperationId(parts: readonly unknown[]): string {
  return `memop_${createMemoryDigest([MEMORY_OPERATION_DOMAIN, ...parts])}`;
}

export function createMemoryDigest(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

function restoreCallbackContext(session: DurableMemoryCallbackSession): SessionContext {
  const live = buildCallbackContext();
  return { ...live, session };
}
