import { createHash } from "node:crypto";

import type { ModelMessage } from "ai";

import { loadDefaultMemoryNamespaceContext } from "#context/default-memory-namespace-context.js";
import type { Approval } from "#public/definitions/approval.js";
import type { SessionContext } from "#public/definitions/callback-context.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { ToolDefinition } from "#public/definitions/tool.js";
import type { DynamicResolveContext } from "#shared/dynamic-tool-definition.js";
import { resolveVercelProjectIdFromEnvironment } from "#shared/vercel-project.js";

/** Application-owned memory domain, resolved when eve locks a memory operation. */
export type MemoryNamespaceDefinition =
  | string
  | null
  | Promise<string | null>
  | (() => string | null | Promise<string | null>);

/** Trusted memory audience or container, resolved when eve locks a memory operation. */
export type MemoryScopeDefinition =
  | string
  | null
  | Promise<string | null>
  | (() => string | null | Promise<string | null>);

/** Stable provider partition resolved and locked by eve for one memory slot. */
export interface MemoryScope {
  /** Collision-resistant key derived from exactly {@link namespace} and {@link value}. */
  readonly key: string;
  /** Resolved application-owned memory domain. */
  readonly namespace: string;
  /** Resolved trusted audience or container within {@link namespace}. */
  readonly value: string;
}

/** Provider-formatted context projected into model calls for one scope. */
export interface MemoryProjection {
  /** Non-empty provider context projected as one synthetic user-role message. */
  readonly content: string;
}

/** Normalized input and durable coordinates for the active turn. */
export interface MemoryTurnContext {
  /** Normalized model messages accepted as input for this turn. */
  readonly input: readonly ModelMessage[];
  /** Zero-based durable turn sequence. */
  readonly sequence: number;
  readonly turnId: string;
}

/** Shared context supplied to memory recall and save operations. */
export interface MemoryOperationContext extends SessionContext {
  /** Aborts when the active turn or standalone operation is cancelled. */
  readonly abortSignal: AbortSignal;
  /** Durable model history at this boundary. Excludes memory projections. */
  readonly messages: readonly ModelMessage[];
  /** Identifies one logical recall or save operation across workflow replay. */
  readonly operationId: string;
  readonly memory: {
    /** Current projection for this slot and active scope, if one exists. */
    readonly current: MemoryProjection | null;
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
export type MemorySaveContext = MemoryOperationContext &
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
    /** Current projection after turn-start recall. */
    readonly current: MemoryProjection | null;
    /** Trusted partition locked for the active turn. */
    readonly scope: MemoryScope;
    /** Path-derived authored slot identity. */
    readonly slot: string;
  };
  readonly turn: MemoryTurnContext;
}

/** A recall replaces, clears, or preserves the active scope's projection. */
export type MemoryRecallResult = MemoryProjection | null | undefined;

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
  save?(context: MemorySaveContext): void | Promise<void>;
  tools?(context: MemoryToolsContext): MemoryToolSet | null | Promise<MemoryToolSet | null>;
}

/** Controls which recalled projections remain model-visible after a scope change. */
export type MemoryVisibility = "scope" | "session";

/** Path-authored memory slot definition. Identity is derived from its file path. */
export interface MemoryDefinition {
  /** Application-owned memory domain. Defaults to {@link defaultNamespace}. */
  readonly namespace?: MemoryNamespaceDefinition;
  readonly provider: MemoryProvider;
  readonly scope: MemoryScopeDefinition;
  /** Projection visibility across scope changes. Defaults to `"scope"`. */
  readonly visibility?: MemoryVisibility;
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

/** Builds eve's deployment-aware default namespace for the memory slot being resolved. */
export function defaultNamespace(): string {
  const context = loadDefaultMemoryNamespaceContext();
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
    context.nodeId,
    context.slot,
  ]);
}
