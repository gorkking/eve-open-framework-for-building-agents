import type { ModelMessage } from "ai";

import { createDurableDynamicToolMetadata } from "#context/durable-dynamic-tool-metadata.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import {
  SessionDynamicToolMetadataKey,
  StepDynamicToolMetadataKey,
  TurnDynamicToolMetadataKey,
  type DurableDynamicToolMetadata,
  type RuntimeToolContributionProvenance,
} from "#context/keys.js";
import { createLogger } from "#internal/logging.js";
import type { DynamicToolEntry, DynamicToolEventName } from "#shared/dynamic-tool-definition.js";
import { isBrandedToolEntry } from "#shared/dynamic-tool-definition.js";
import { toErrorMessage } from "#shared/errors.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";

const log = createLogger("dynamic-tools");

/**
 * Internal seam for framework runtime features that contribute branded
 * dynamic tools outside the authored `defineDynamic` resolver path
 * (`connection_search` today; scoped provider tooling later). Contributions
 * flow through the same validation, durable callback capture, tier storage,
 * and replay machinery as authored dynamic tools — this module owns only the
 * owner-scoped transaction around them.
 */

export interface RuntimeToolContributorContributeInput {
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}

/** A runtime feature that produces a qualified map of dynamic tools at lifecycle boundaries. */
export interface RuntimeToolContributor {
  /** Identity whose active set is replaced atomically on each contribution. */
  readonly ownerId: string;
  /** Advertisement identity for introspection surfaces. */
  readonly slug: string;
  readonly logicalPath: string;
  readonly sourceId: string;
  readonly sourceKind: string;
  readonly eventNames: readonly DynamicToolEventName[];
  /**
   * Builds the current tool set. Return `null` to contribute nothing and
   * remove any prior contribution at this boundary's scope. Throwing fails
   * this owner's whole result: nothing partial becomes callable.
   */
  contribute(
    input: RuntimeToolContributorContributeInput,
  ):
    | Readonly<Record<string, DynamicToolEntry>>
    | null
    | Promise<Readonly<Record<string, DynamicToolEntry>> | null>;
}

const CONTRIBUTOR_REGISTRY = Symbol.for("eve:runtime-tool-contributors");

function getContributorRegistry(): RuntimeToolContributor[] {
  const global = globalThis as Record<symbol, RuntimeToolContributor[] | undefined>;
  const existing = global[CONTRIBUTOR_REGISTRY];
  if (existing !== undefined) return existing;
  const registry: RuntimeToolContributor[] = [];
  global[CONTRIBUTOR_REGISTRY] = registry;
  return registry;
}

/** Registers one runtime contributor, replacing any prior registration with the same owner id. */
export function registerRuntimeToolContributor(contributor: RuntimeToolContributor): void {
  const registry = getContributorRegistry();
  const index = registry.findIndex((entry) => entry.ownerId === contributor.ownerId);
  if (index >= 0) {
    registry[index] = contributor;
    return;
  }
  registry.push(contributor);
}

export function getRuntimeToolContributors(): readonly RuntimeToolContributor[] {
  return [...getContributorRegistry()];
}

export interface RuntimeToolContributionInput {
  readonly ctx: ContextContainer;
  /** Lifecycle coordinate of the contribution; selects the durable metadata tier. */
  readonly coordinate: {
    readonly event: DynamicToolEventName;
    readonly stepIndex?: number;
    readonly turnId?: string;
  };
  readonly ownerId: string;
  /** Optional namespace applied exactly once as `${prefix}__${key}` to every entry key. */
  readonly qualificationPrefix?: string;
  readonly runtimeRevision: string;
  readonly sourceId: string;
  /** Keyed map of branded tools, or `null`/empty to remove this owner's prior contribution. */
  readonly tools: Readonly<Record<string, DynamicToolEntry>> | null;
}

export function durableKeyForEvent(
  eventType: string,
): ContextKey<readonly DurableDynamicToolMetadata[]> | undefined {
  switch (eventType) {
    case "session.started":
      return SessionDynamicToolMetadataKey;
    case "turn.started":
      return TurnDynamicToolMetadataKey;
    case "step.started":
      return StepDynamicToolMetadataKey;
    default:
      return undefined;
  }
}

interface PreparedContribution {
  readonly ownerId: string;
  readonly metadata: readonly DurableDynamicToolMetadata[];
}

/** Validates and captures one owner's tool set without publishing anything. */
function prepareContribution(input: {
  readonly ownerId: string;
  readonly qualificationPrefix?: string;
  readonly runtimeRevision: string;
  readonly sourceId: string;
  readonly tools: Readonly<Record<string, DynamicToolEntry>> | null;
}): PreparedContribution {
  if (typeof input.ownerId !== "string" || input.ownerId === "") {
    throw new Error(`Runtime tool contribution requires a non-empty ownerId.`);
  }
  if (
    input.qualificationPrefix !== undefined &&
    (typeof input.qualificationPrefix !== "string" || input.qualificationPrefix === "")
  ) {
    throw new Error(
      `Runtime tool contribution "${input.ownerId}" requires a non-empty qualificationPrefix.`,
    );
  }
  if (typeof input.sourceId !== "string" || input.sourceId === "") {
    throw new Error(`Runtime tool contribution "${input.ownerId}" requires a non-empty sourceId.`);
  }

  const tools = input.tools;
  if (tools === null) return { ownerId: input.ownerId, metadata: [] };
  if (typeof tools !== "object" || Array.isArray(tools)) {
    throw new Error(
      `Runtime tool contribution "${input.ownerId}" must be a keyed map of defineTool() values or null.`,
    );
  }
  if (isBrandedToolEntry(tools)) {
    throw new Error(
      `Runtime tool contribution "${input.ownerId}" must be a keyed map of defineTool() values, not a lone tool. Wrap every entry in a record keyed by its local name.`,
    );
  }

  const prefix = input.qualificationPrefix === undefined ? "" : `${input.qualificationPrefix}__`;
  const provenance: RuntimeToolContributionProvenance = {
    ownerId: input.ownerId,
    runtimeRevision: input.runtimeRevision,
    sourceId: input.sourceId,
  };
  const seen = new Set<string>();
  const metadata = Object.entries(tools).map(([key, entry]) => {
    if (!isBrandedToolEntry(entry)) {
      throw new Error(
        `Runtime tool contribution "${key}" from owner "${input.ownerId}" is not wrapped in defineTool(). Wrap every contributed tool entry in defineTool().`,
      );
    }
    const name = `${prefix}${key}`;
    if (seen.has(name)) {
      throw new Error(
        `Runtime tool contribution "${input.ownerId}" produced duplicate qualified name "${name}".`,
      );
    }
    seen.add(name);
    return createDurableDynamicToolMetadata({
      entry: entry as DynamicToolEntry,
      entryKey: key,
      name,
      provenance,
      resolverSlug: input.ownerId,
    });
  });
  return { ownerId: input.ownerId, metadata };
}

function findCollision(
  batches: readonly PreparedContribution[],
): { readonly incomingOwnerId: string; readonly name: string; readonly owner: string } | undefined {
  const ownersByName = new Map<string, string>();
  for (const batch of batches) {
    for (const entry of batch.metadata) {
      const previousOwner = ownersByName.get(entry.name);
      if (previousOwner !== undefined && previousOwner !== batch.ownerId) {
        return { incomingOwnerId: batch.ownerId, name: entry.name, owner: previousOwner };
      }
      ownersByName.set(entry.name, batch.ownerId);
    }
  }
  return undefined;
}

/**
 * Contributes runtime tools through the same validation and durable callback
 * capture path as authored dynamic tools, replacing this owner's active set
 * at the coordinate's scope atomically. A `null` or empty map removes only
 * this owner's prior contribution.
 */
export function contributeRuntimeTools(
  input: RuntimeToolContributionInput,
): readonly DurableDynamicToolMetadata[] {
  const key = durableKeyForEvent(input.coordinate.event);
  if (key === undefined) {
    throw new Error(
      `Runtime tool contribution "${input.ownerId}" uses unsupported event "${String(input.coordinate.event)}".`,
    );
  }
  const prepared = prepareContribution(input);
  const prior = input.ctx.get(key) ?? [];

  const otherOwners = prior
    .filter((entry) => entry.contribution !== undefined && entry.resolverSlug !== prepared.ownerId)
    .map((entry): PreparedContribution => ({
      metadata: [entry],
      ownerId: entry.resolverSlug,
    }));
  const collision = findCollision([...otherOwners, prepared]);
  if (collision !== undefined) {
    throw new Error(
      `Dynamic tool "${collision.name}" contributed by runtime owner "${prepared.ownerId}" collides with owner "${collision.owner}". Namespace the map key manually.`,
    );
  }

  const kept = prior.filter((entry) => entry.contribution?.ownerId !== prepared.ownerId);
  const next = [...kept, ...prepared.metadata];
  input.ctx.set(key, next);
  return prepared.metadata;
}

/**
 * Runs every registered contributor matching the event and publishes their
 * combined result as one tier update. A contributor failure publishes
 * nothing from that owner and drops its prior entries at this scope; a
 * cross-owner collision fails the enclosing operation before anything is
 * published. Returns the full metadata array to persist for the tier —
 * resolver-produced entries first, then contributions.
 */
export async function applyRuntimeToolContributions(input: {
  readonly ctx: ContextContainer;
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
  /** Resolver-produced metadata for this boundary, composed ahead of contributions. */
  readonly resolverMetadata: readonly DurableDynamicToolMetadata[];
  /**
   * Which persisted resolver-owned entries this boundary replaces: `"all"`
   * for full-replace tiers (`session.started`, `step.started`), or the set of
   * resolver slugs owned by this boundary for merge tiers (`turn.started`).
   */
  readonly replacesResolverEntries: ReadonlySet<string> | "all";
  readonly runtimeRevision: string;
}): Promise<readonly DurableDynamicToolMetadata[]> {
  const key = durableKeyForEvent(input.event.type);
  if (key === undefined) return input.resolverMetadata;

  const batches: PreparedContribution[] = [];
  for (const contributor of getRuntimeToolContributors()) {
    if (!contributor.eventNames.includes(input.event.type as DynamicToolEventName)) continue;
    try {
      const tools = await contributor.contribute({
        event: input.event,
        messages: input.messages,
      });
      batches.push(
        prepareContribution({
          ownerId: contributor.ownerId,
          runtimeRevision: input.runtimeRevision,
          sourceId: contributor.sourceId,
          tools: tools as Readonly<Record<string, DynamicToolEntry>> | null,
        }),
      );
    } catch (error) {
      log.error(
        `Runtime tool contributor (${input.event.type}) failed — publishing nothing from it.`,
        {
          ownerId: contributor.ownerId,
          error: toErrorMessage(error),
        },
      );
      batches.push({ ownerId: contributor.ownerId, metadata: [] });
    }
  }

  const collision = findCollision(batches);
  if (collision !== undefined) {
    throw new Error(
      `Dynamic tool "${collision.name}" contributed by runtime owner "${collision.incomingOwnerId}" collides with owner "${collision.owner}". Namespace the map key manually.`,
    );
  }

  const slugs = input.replacesResolverEntries;
  const kept = (input.ctx.get(key) ?? []).filter((entry) => {
    if (entry.contribution !== undefined) return false;
    return slugs !== "all" && !slugs.has(entry.resolverSlug);
  });
  const next = [...kept, ...input.resolverMetadata, ...batches.flatMap((batch) => batch.metadata)];
  input.ctx.set(key, next);
  return next;
}
