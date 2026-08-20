import { createHash } from "node:crypto";

import type { ModelMessage } from "ai";

import type { SessionAuth } from "#context/keys.js";
import type { Approval } from "#public/definitions/approval.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { ToolDefinition } from "#public/definitions/tool.js";
import type { DynamicResolveContext } from "#shared/dynamic-tool-definition.js";
import { readMemoryMessageAttribution } from "#shared/memory-message.js";
import { resolveVercelProjectIdFromEnvironment } from "#shared/vercel-project.js";

/** Deployment coordinates supplied to a memory namespace resolver. */
export interface MemoryNamespaceContext {
  /** Absolute application root used for the non-Vercel default-namespace fallback. */
  readonly appRoot: string;
  /** Graph node that owns the slot. */
  readonly node: string;
  /** Path-derived slot identity, such as "memory" or "user". */
  readonly slot: string;
}

/** Application-owned memory domain, resolved when eve locks a memory operation. */
export type MemoryNamespaceDefinition =
  | string
  | null
  | ((context: MemoryNamespaceContext) => string | null | Promise<string | null>);

/** Values accepted from a trusted memory scope resolver. Arrays are joined with `":"`. */
export type MemoryScopeResolverResult = string | readonly string[] | null;

/** Trusted request context supplied when eve locks a memory scope. */
export interface MemoryScopeContext {
  /** Aborts when the active turn or standalone operation is cancelled. */
  readonly abortSignal: AbortSignal;
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
  };
  /** Channel metadata for the request that triggered this operation. */
  readonly channel: {
    readonly kind?: string;
    readonly continuationToken?: string;
    readonly metadata?: Readonly<Record<string, unknown>>;
  };
}

/** Trusted memory audience or container, resolved when eve locks a memory operation. */
export type MemoryScopeDefinition =
  | string
  | null
  | ((
      context: MemoryScopeContext,
    ) => MemoryScopeResolverResult | Promise<MemoryScopeResolverResult>);

/** Stable provider partition resolved and locked by eve for one memory slot. */
export interface MemoryScope {
  /** Collision-resistant key derived from exactly {@link namespace} and {@link value}. */
  readonly key: string;
  /** Resolved application-owned memory domain. */
  readonly namespace: string;
  /** Resolved trusted audience or container within {@link namespace}. */
  readonly value: string;
}

/** Provider context appended to durable history by one recall operation. */
export interface MemoryRecallMessage {
  readonly content: string;
  /** Defaults to `"user"`. */
  readonly role?: "system" | "user";
}

/** Origin attached by eve to a recalled message in durable history. */
export interface MemoryMessageAttribution {
  readonly scope: MemoryScope;
  readonly slot: string;
}

/** Normalized input and durable coordinates for the active turn. */
export interface MemoryTurnContext {
  /** Stable turn ID, matching `ctx.session.turn.id`. */
  readonly id: string;
  /** Normalized model messages accepted as input for this turn. */
  readonly input: readonly ModelMessage[];
  /** Zero-based durable turn sequence. */
  readonly sequence: number;
}

/** Shared context supplied to memory recall and capture operations. */
export interface MemoryOperationContext extends SessionContext {
  /** Aborts when the active turn or standalone operation is cancelled. */
  readonly abortSignal: AbortSignal;
  /** Durable model history at this boundary, including prior recalls. */
  readonly messages: readonly ModelMessage[];
  /** Identifies one logical recall or capture operation across workflow replay. */
  readonly operationId: string;
  readonly memory: {
    /** Trusted partition locked for the active turn or standalone operation. */
    readonly scope: MemoryScope;
    /** Path-derived authored slot identity. */
    readonly slot: string;
  };
}

/** Context supplied when eve recalls provider context for the model. */
export type MemoryRecallContext = MemoryOperationContext &
  (
    | {
        readonly compaction?: never;
        readonly phase: "turn.started";
        readonly turn: MemoryTurnContext;
      }
    | {
        readonly compaction: {
          readonly modelId: string;
        };
        readonly phase: "compaction.completed";
        /** Null for standalone manual compaction. */
        readonly turn: MemoryTurnContext | null;
      }
  );

/** Context supplied when eve asks a provider to preserve settled history. */
export type MemoryCaptureContext = MemoryOperationContext &
  (
    | {
        readonly compaction: {
          readonly modelId: string;
          readonly usageInputTokens: number | null;
        };
        readonly phase: "compaction.requested";
        /** Null for standalone manual compaction. */
        readonly turn: MemoryTurnContext | null;
      }
    | {
        readonly compaction?: never;
        readonly phase: "turn.completed";
        readonly turn: MemoryTurnContext;
      }
  );

/** Context supplied when resolving a memory slot's tools for the active turn. */
export interface MemoryToolsContext extends DynamicResolveContext {
  readonly memory: {
    /** Trusted partition locked for the active turn. */
    readonly scope: MemoryScope;
    /** Path-derived authored slot identity. */
    readonly slot: string;
  };
  readonly turn: MemoryTurnContext;
}

/** One append-only recall message, or no message for this recall boundary. */
export type MemoryRecallResult = MemoryRecallMessage | null | undefined;

/** One provider-owned model tool with its authoring-time input and output types erased. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MemoryToolDefinition = Omit<ToolDefinition<any, any>, "approval"> & {
  // The heterogeneous provider boundary intentionally erases each tool's inferred input type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly approval?: Approval<any>;
};

/** Provider-owned model tools resolved once for one memory slot and turn. */
export type MemoryToolSet = Readonly<Record<string, MemoryToolDefinition>>;

/** Provider-owned behavior attached to one or more authored memory slots. */
export interface MemoryProvider {
  recall(context: MemoryRecallContext): MemoryRecallResult | Promise<MemoryRecallResult>;
  capture?(context: MemoryCaptureContext): void | Promise<void>;
  tools?(context: MemoryToolsContext): MemoryToolSet | null | Promise<MemoryToolSet | null>;
}

/** Controls which recalled messages remain model-visible after a scope change. */
export type MemoryVisibility = "scope" | "session";

/** Path-authored memory slot definition. Identity is derived from its file path. */
export interface MemoryDefinition {
  /** Optional model-facing purpose prepended to every provider tool description. */
  readonly description?: string;
  /** Application-owned memory domain. Defaults to {@link defaultNamespace}. */
  readonly namespace?: MemoryNamespaceDefinition;
  readonly provider: MemoryProvider;
  readonly scope: MemoryScopeDefinition;
  /** Recall-message visibility across scope changes. Defaults to `"scope"`. */
  readonly visibility?: MemoryVisibility;
}

/** Returns the memory origin attached to a recalled history message, if present. */
export function getMemoryMessageAttribution(
  message: ModelMessage,
): MemoryMessageAttribution | null {
  const attribution = readMemoryMessageAttribution(message);
  return attribution === null
    ? null
    : {
        scope: { ...attribution.scope },
        slot: attribution.slot,
      };
}

/** Defines provider-owned memory behavior without imposing a storage model. */
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

/**
 * Builds eve's deployment-aware default namespace for the memory slot being
 * resolved. A pure function of the supplied context and the deployment
 * environment, so custom namespace resolvers can compose with it.
 */
export function defaultNamespace(context: MemoryNamespaceContext): string {
  const projectId = resolveVercelProjectIdFromEnvironment();
  const application =
    projectId === undefined
      ? ["local", createHash("sha256").update(context.appRoot).digest("base64url")]
      : ["vercel", projectId];
  const environment =
    process.env.VERCEL_TARGET_ENV?.trim() ||
    process.env.VERCEL_ENV?.trim() ||
    process.env.NODE_ENV?.trim() ||
    "unknown";
  return JSON.stringify([
    "eve-memory-default-namespace-v1",
    application,
    environment,
    context.node,
    context.slot,
  ]);
}
