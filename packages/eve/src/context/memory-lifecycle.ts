import { createHash } from "node:crypto";
import type { ModelMessage } from "ai";

import type { SessionAuthContext } from "#channel/types.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import { contextStorage, type AlsContext } from "#context/container.js";
import {
  SessionKey,
  TurnMemoryStateKey,
  type DurableMemorySlotState,
  type DurableTurnMemoryState,
} from "#context/keys.js";
import { createLogger } from "#internal/logging.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type {
  MemoryProviderContext,
  MemoryProviderEvents,
  MemoryScope,
} from "#public/memory/index.js";
import type { HookContext, StreamEventHook } from "#public/definitions/hook.js";
import type { ResolvedHookDefinition, ResolvedMemoryDefinition } from "#runtime/types.js";
import { toErrorMessage } from "#shared/errors.js";

const log = createLogger("memory");
const MEMORY_HOOK_EVENTS = [
  "turn.started",
  "message.received",
  "compaction.requested",
  "compaction.completed",
  "turn.completed",
] as const;
const MEMORY_MESSAGE_EVENTS = new Set<keyof MemoryProviderEvents>([
  "turn.started",
  "message.received",
]);

interface MemoryIdentity {
  readonly agentId: string;
  readonly nodeId: string;
}

type MemoryMessageResult = string | null | void;

/** Locks memory scopes before ordinary hook and dynamic dispatch. */
export function prepareMemoryLifecycleEvent(input: {
  readonly ctx: AlsContext;
  readonly event: MessageStreamEvent;
  readonly identity: MemoryIdentity;
  readonly memories: readonly ResolvedMemoryDefinition[];
}): void {
  if (input.memories.length === 0) return;

  switch (input.event.type) {
    case "turn.started": {
      const state = input.ctx.get(TurnMemoryStateKey);
      if (state?.pendingApprovalPrincipal !== undefined) {
        const current = input.ctx.require(SessionKey).auth.current;
        if (state.pendingApprovalPrincipal !== principalIdentity(current)) {
          throw new Error(
            "Memory tool approval must be resumed by the principal that initiated it.",
          );
        }
        const { pendingApprovalPrincipal: _, ...activeState } = state;
        input.ctx.set(TurnMemoryStateKey, {
          ...activeState,
          deferred: false,
          sequence: input.event.data.sequence,
          turnId: input.event.data.turnId,
        });
        return;
      }
      input.ctx.set(
        TurnMemoryStateKey,
        resolveTurnState({
          identity: input.identity,
          memories: input.memories,
          sequence: input.event.data.sequence,
          turnId: input.event.data.turnId,
        }),
      );
      return;
    }
    case "input.requested": {
      const state = input.ctx.get(TurnMemoryStateKey);
      if (state !== undefined) {
        const requestsMemoryApproval = input.event.data.requests.some(
          (request) =>
            request.kind === "tool-approval" &&
            state.slots.some(({ slot }) => request.action.toolName.startsWith(`${slot}__`)),
        );
        input.ctx.set(TurnMemoryStateKey, {
          ...state,
          deferred: true,
          ...(requestsMemoryApproval
            ? {
                pendingApprovalPrincipal: principalIdentity(
                  input.ctx.require(SessionKey).auth.current,
                ),
              }
            : {}),
        });
      }
      return;
    }
    case "compaction.requested":
    case "compaction.completed":
      ensureTurnState(input, input.event.data.sequence, input.event.data.turnId);
      return;
    default:
      return;
  }
}

function principalIdentity(principal: SessionAuthContext | null): string {
  return JSON.stringify(
    principal === null
      ? null
      : [principal.principalType, principal.authenticator, principal.principalId],
  );
}

/** Adapts provider lifecycle callbacks into eve's ordinary hook registry. */
export function createMemoryHookDefinitions(
  memories: readonly ResolvedMemoryDefinition[],
): readonly ResolvedHookDefinition[] {
  return memories.flatMap((memory) => {
    const events: Record<string, StreamEventHook<MessageStreamEvent>> = {};

    for (const eventName of MEMORY_HOOK_EVENTS) {
      const handler = memory.provider.events?.[eventName];
      if (handler === undefined) continue;
      events[eventName] = async (event, hookContext) => {
        const active = getActiveMemory(memory.slot);
        if (active === null || (eventName === "turn.completed" && active.state.deferred)) {
          return;
        }
        const messageEventKey = `${eventName}:${memory.slot}`;
        if (
          MEMORY_MESSAGE_EVENTS.has(eventName) &&
          active.state.handledMessageEvents.includes(messageEventKey)
        ) {
          return;
        }

        const providerContext = buildMemoryProviderContext(active.slot, hookContext);
        try {
          const result = await invokeMemoryHook(handler, event, providerContext);
          if (MEMORY_MESSAGE_EVENTS.has(eventName)) {
            recordMemoryMessage(messageEventKey, memory.slot, result);
          }
        } catch (error) {
          if (eventName === "compaction.requested" || MEMORY_MESSAGE_EVENTS.has(eventName)) {
            throw error;
          }
          log.error(`Memory provider ${eventName} handler failed after settlement.`, {
            error: toErrorMessage(error),
            slot: memory.slot,
          });
        }
      };
    }

    if (Object.keys(events).length === 0) return [];
    return [
      {
        events,
        exportName: memory.exportName,
        logicalPath: memory.logicalPath,
        slug: `memory:${memory.slot}`,
        sourceId: `${memory.sourceId}#events`,
        sourceKind: "module" as const,
      },
    ];
  });
}

/** Takes memory messages returned by real turn events for durable materialization. */
export function takePendingMemoryMessages(): readonly ModelMessage[] {
  const ctx = contextStorage.getStore();
  const state = ctx?.get(TurnMemoryStateKey);
  if (ctx === undefined || state === undefined || state.pendingMessages.length === 0) return [];
  ctx.set(TurnMemoryStateKey, { ...state, pendingMessages: [] });
  return state.pendingMessages.map((content) => ({ content, role: "user" }));
}

/** Builds the scoped callback context used by memory-owned dynamic tools. */
export function createMemoryProviderContext(input: {
  readonly abortSignal: AbortSignal;
  readonly messages: readonly ModelMessage[];
  readonly slot: string;
}): MemoryProviderContext | null {
  const active = getActiveMemory(input.slot);
  if (active === null) return null;
  return {
    ...buildCallbackContext(),
    abortSignal: input.abortSignal,
    memory: active.slot,
    messages: input.messages,
  };
}

function buildMemoryProviderContext(
  slot: DurableMemorySlotState,
  hookContext: HookContext,
): MemoryProviderContext {
  return {
    ...hookContext,
    memory: slot,
  };
}

function getActiveMemory(
  slot: string,
): { readonly slot: DurableMemorySlotState; readonly state: DurableTurnMemoryState } | null {
  const state = contextStorage.getStore()?.get(TurnMemoryStateKey);
  const active = state?.slots.find((candidate) => candidate.slot === slot);
  return state === undefined || active === undefined ? null : { slot: active, state };
}

function resolveTurnState(input: {
  readonly identity: MemoryIdentity;
  readonly memories: readonly ResolvedMemoryDefinition[];
  readonly sequence: number;
  readonly turnId: string;
}): DurableTurnMemoryState {
  const callbackContext = buildCallbackContext();
  const slots: DurableMemorySlotState[] = [];

  for (const memory of input.memories) {
    const parts = memory.scope(callbackContext);
    if (parts === null) continue;
    validateScopeParts(memory.slot, parts);
    slots.push({
      scope: createScope(input.identity, memory.slot, parts),
      slot: memory.slot,
    });
  }

  return {
    deferred: false,
    handledMessageEvents: [],
    pendingMessages: [],
    sequence: input.sequence,
    slots,
    turnId: input.turnId,
  };
}

function ensureTurnState(
  input: {
    readonly ctx: AlsContext;
    readonly identity: MemoryIdentity;
    readonly memories: readonly ResolvedMemoryDefinition[];
  },
  sequence: number,
  turnId: string,
): DurableTurnMemoryState {
  const existing = input.ctx.get(TurnMemoryStateKey);
  if (existing !== undefined) return existing;
  const state = resolveTurnState({ ...input, sequence, turnId });
  input.ctx.set(TurnMemoryStateKey, state);
  return state;
}

function createScope(
  identity: MemoryIdentity,
  slot: string,
  parts: readonly string[],
): MemoryScope {
  const environment =
    process.env.VERCEL_TARGET_ENV ??
    process.env.VERCEL_ENV ??
    process.env.NODE_ENV ??
    "development";
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        "eve-memory-v1",
        identity.agentId,
        environment,
        identity.nodeId,
        slot,
        parts,
      ]),
    )
    .digest("base64url");
  return { key: `mem_${digest}`, parts: [...parts] };
}

function validateScopeParts(slot: string, parts: readonly string[]): void {
  if (!Array.isArray(parts)) {
    throw new TypeError(`Memory scope "${slot}" must return an array of strings or null.`);
  }
  for (const part of parts) {
    if (typeof part !== "string" || part.length === 0) {
      throw new TypeError(`Memory scope "${slot}" returned an empty or non-string scope part.`);
    }
  }
}

function recordMemoryMessage(eventKey: string, slot: string, value: unknown): void {
  const ctx = contextStorage.getStore();
  const state = ctx?.get(TurnMemoryStateKey);
  if (ctx === undefined || state === undefined) return;
  const content = normalizeMemoryMessage(slot, value);
  ctx.set(TurnMemoryStateKey, {
    ...state,
    handledMessageEvents: [...state.handledMessageEvents, eventKey],
    pendingMessages:
      content === undefined ? state.pendingMessages : [...state.pendingMessages, content],
  });
}

function normalizeMemoryMessage(slot: string, value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`Memory provider "${slot}" returned a non-string memory message.`);
  }
  return value.trim().length === 0 ? undefined : value;
}

async function invokeMemoryHook(
  handler: NonNullable<MemoryProviderEvents[keyof MemoryProviderEvents]>,
  event: MessageStreamEvent,
  context: MemoryProviderContext,
): Promise<MemoryMessageResult> {
  return await (
    handler as (
      event: MessageStreamEvent,
      context: MemoryProviderContext,
    ) => MemoryMessageResult | Promise<MemoryMessageResult>
  )(event, context);
}
