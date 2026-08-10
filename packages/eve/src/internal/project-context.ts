import { resolve } from "node:path";

import {
  resolveAgentCollection,
  resolveOwningAgentCollection,
  type AgentCollection,
  type AgentCollectionMember,
} from "#internal/agent-collection.js";

export type EveProjectContext =
  | { readonly kind: "collection"; readonly collection: AgentCollection }
  | {
      readonly kind: "collection-member";
      readonly collection: AgentCollection;
      readonly member: AgentCollectionMember;
    }
  | { readonly kind: "standalone"; readonly appRoot: string };

/** Classify the current filesystem scope before command-specific policy runs. */
export async function resolveEveProjectContext(appRoot: string): Promise<EveProjectContext> {
  const member = await resolveOwningAgentCollection(appRoot);
  if (member !== undefined) return { ...member, kind: "collection-member" };
  const collection = await resolveAgentCollection(appRoot);
  return collection === undefined
    ? { appRoot: resolve(appRoot), kind: "standalone" }
    : { collection, kind: "collection" };
}
