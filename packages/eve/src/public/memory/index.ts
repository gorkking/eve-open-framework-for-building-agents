import type { ModelMessage } from "ai";

import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { HookEventMap } from "#public/definitions/hook.js";
import {
  defineDynamic as defineDynamicBase,
  type ToolContext,
  type ToolDefinition,
} from "#public/definitions/tool.js";
import type { DynamicSentinel } from "#shared/dynamic-tool-definition.js";

/** One opaque identifier in an authored memory partition tuple. */
export type MemoryScopePart = string;

/** Stable provider partition resolved and locked by eve for one memory slot. */
export interface MemoryScope {
  /** Collision-resistant eve namespace for this application, environment, slot, and tuple. */
  readonly key: string;
  /** Ordered authored identifiers used to derive {@link key}. */
  readonly parts: readonly MemoryScopePart[];
}

/** Trusted authored context available while resolving a memory partition. */
export interface MemoryScopeContext extends SessionContext {
  /** Aborts when the active turn or manual operation is cancelled. */
  readonly abortSignal: AbortSignal;
}

/** Resolves one trusted provider partition, or disables the slot for this turn. */
export type MemoryScopeDefinition = (
  context: MemoryScopeContext,
) => readonly MemoryScopePart[] | null | Promise<readonly MemoryScopePart[] | null>;

/** Memory-specific context supplied to every provider handler and tool resolver. */
export interface MemoryProviderContext extends SessionContext {
  /** Aborts when the active turn is cancelled. */
  readonly abortSignal: AbortSignal;
  /** Complete durable model history selected for this lifecycle point. */
  readonly messages: readonly ModelMessage[];
  readonly memory: {
    /** Path-derived authored slot identity. */
    readonly slot: string;
    /** Trusted partition locked for the active turn or manual operation. */
    readonly scope: MemoryScope;
  };
}

/** One provider-owned message to materialize into durable model history. */
export interface MemoryMessage {
  readonly content: string;
}

/** Messages materialized by one memory lifecycle event, or no materialization. */
export type MemoryEventResult = MemoryMessage | readonly MemoryMessage[] | null | void;

/** Provider-owned model tools for one memory lifecycle boundary. */
interface MemoryProviderTool {
  readonly approval?: ToolDefinition<never, unknown>["approval"];
  readonly description: ToolDefinition["description"];
  execute(input: unknown, context: ToolContext): unknown;
  readonly inputSchema: ToolDefinition["inputSchema"];
  readonly outputSchema?: ToolDefinition["outputSchema"];
  readonly toModelOutput?: ToolDefinition<never, never>["toModelOutput"];
}
type MemoryProviderToolSet = Readonly<Record<string, MemoryProviderTool>>;

interface MemoryDynamicEventMap {
  readonly "step.started": HookEventMap["step.started"];
}

type MemoryDynamicEvents<TResult = unknown> = {
  readonly [K in keyof MemoryDynamicEventMap]?: (
    event: MemoryDynamicEventMap[K],
    context: MemoryProviderContext,
  ) => TResult | Promise<TResult>;
};

type MemoryDynamicHandler<TEvents extends MemoryDynamicEvents> = Extract<
  NonNullable<TEvents[keyof TEvents]>,
  (...args: never[]) => unknown
>;

type MemoryDynamicResult<TEvents extends MemoryDynamicEvents> = Awaited<
  ReturnType<MemoryDynamicHandler<TEvents>>
>;

/** The standard dynamic sentinel with memory-specific events and callback context. */
type MemoryDynamicSentinel<TResult = unknown> = Omit<DynamicSentinel<TResult>, "events"> & {
  readonly events: MemoryDynamicEvents<TResult>;
};

type MemoryEventHandler<TEvent> = (
  event: TEvent,
  context: MemoryProviderContext,
) => MemoryEventResult | Promise<MemoryEventResult>;

/** Lifecycle handlers owned by a memory provider. */
export interface MemoryProviderEvents {
  readonly "session.started"?: MemoryEventHandler<HookEventMap["session.started"]>;
  readonly "turn.started"?: MemoryEventHandler<HookEventMap["turn.started"]>;
  readonly "message.received"?: MemoryEventHandler<HookEventMap["message.received"]>;
  readonly "compaction.requested"?: MemoryEventHandler<HookEventMap["compaction.requested"]>;
  readonly "compaction.completed"?: MemoryEventHandler<HookEventMap["compaction.completed"]>;
  readonly "turn.completed"?: MemoryEventHandler<HookEventMap["turn.completed"]>;
}

/** Model-tool resolvers owned by a memory provider. */
type MemoryProviderTools = MemoryDynamicSentinel<MemoryProviderToolSet | null>;

/** Provider-owned behavior attached to one or more authored memory slots. */
export interface MemoryProvider {
  readonly events?: MemoryProviderEvents;
  readonly tools?: MemoryProviderTools;
}

/** Path-authored memory slot definition. Identity is derived from its file path. */
export interface MemoryDefinition {
  readonly provider: MemoryProvider;
  readonly scope: MemoryScopeDefinition;
}

/** Defines provider-owned memory lifecycle behavior without imposing a storage model. */
export function defineMemoryProvider<const T extends MemoryProvider>(
  provider: ExactDefinition<T, MemoryProvider>,
): T {
  return provider;
}

/** Defines one path-authored memory slot. */
export function defineMemory<const T extends MemoryDefinition>(
  definition: ExactDefinition<T, MemoryDefinition>,
): T {
  return definition;
}

/** Defines dynamic memory tools using eve's standard dynamic capability primitive. */
export function defineDynamic<const TEvents extends MemoryDynamicEvents>(definition: {
  readonly events: TEvents;
}): MemoryDynamicSentinel<MemoryDynamicResult<TEvents>> {
  return defineDynamicBase({ events: definition.events as never }) as MemoryDynamicSentinel<
    MemoryDynamicResult<TEvents>
  >;
}

/** Scopes memory to the authenticated caller; unauthenticated turns disable the slot. */
export function byPrincipal(): MemoryScopeDefinition {
  return (context) => {
    const principal = context.session.auth.current;
    if (principal === null) return null;
    return [principal.principalType, principal.authenticator, principal.principalId];
  };
}
