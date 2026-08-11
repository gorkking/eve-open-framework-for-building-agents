import { basename, dirname, resolve } from "node:path";

import {
  resolveAgentCollection,
  resolveOwningAgentCollection,
  type AgentCollection,
  type AgentCollectionMember,
} from "#internal/agent-collection.js";
import { hasVercelHostFramework } from "#setup/scaffold/index.js";

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
  const resolvedAppRoot = resolve(appRoot);
  const parent = dirname(resolvedAppRoot);
  const possibleCollectionRoot = basename(parent) === "agents" ? dirname(parent) : undefined;
  if (
    possibleCollectionRoot !== undefined &&
    (await hasVercelHostFramework(possibleCollectionRoot))
  ) {
    return { appRoot: resolvedAppRoot, kind: "standalone" };
  }

  const member = await resolveOwningAgentCollection(resolvedAppRoot);
  if (member !== undefined) return { ...member, kind: "collection-member" };
  if (await hasVercelHostFramework(resolvedAppRoot)) {
    return { appRoot: resolvedAppRoot, kind: "standalone" };
  }
  const collection = await resolveAgentCollection(resolvedAppRoot);
  return collection === undefined
    ? { appRoot: resolvedAppRoot, kind: "standalone" }
    : { collection, kind: "collection" };
}
