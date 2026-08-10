import {
  resolveAgentCollection,
  resolveOwningAgentCollection,
  type AgentCollection,
  type AgentCollectionMember,
} from "#internal/agent-collection.js";

export type CollectionCommandTarget =
  | {
      readonly collection: AgentCollection;
      readonly kind: "collection";
    }
  | {
      readonly collection: AgentCollection;
      readonly kind: "member";
      readonly member: AgentCollectionMember;
    };

/** Classify a CLI working directory when it participates in an agent collection. */
export async function resolveCollectionCommandTarget(
  appRoot: string,
): Promise<CollectionCommandTarget | undefined> {
  const owner = await resolveOwningAgentCollection(appRoot);
  if (owner !== undefined) return { ...owner, kind: "member" };
  const collection = await resolveAgentCollection(appRoot);
  return collection === undefined ? undefined : { collection, kind: "collection" };
}
