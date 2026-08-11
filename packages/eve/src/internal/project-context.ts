import { basename, dirname, join, resolve } from "node:path";

import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import {
  resolveAgentCollection,
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

async function isHostOwnedAgentRoot(root: string, source: ProjectSource): Promise<boolean> {
  return source.kind === "disk" && (await hasVercelHostFramework(root));
}

/** Classify a direct `agents/<name>` root using the canonical ownership rules. */
export async function resolveNamedAgentProjectContext(
  appRoot: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<Extract<EveProjectContext, { kind: "collection-member" | "standalone" }> | undefined> {
  const resolvedAppRoot = resolve(appRoot);
  const agentsRoot = dirname(resolvedAppRoot);
  if (basename(agentsRoot) !== "agents") return undefined;

  const source = options.source ?? createDiskProjectSource();
  const ownerRoot = dirname(agentsRoot);
  if (await isHostOwnedAgentRoot(ownerRoot, source)) {
    return { appRoot: resolvedAppRoot, kind: "standalone" };
  }
  if ((await source.stat(join(ownerRoot, "package.json"))) !== "file") return undefined;

  const collection = await resolveAgentCollection(ownerRoot, { source });
  const member = collection?.members.find((candidate) => candidate.appRoot === resolvedAppRoot);
  return collection === undefined || member === undefined
    ? undefined
    : { collection, kind: "collection-member", member };
}

/** Classify the current filesystem scope before command-specific policy runs. */
export async function resolveEveProjectContext(appRoot: string): Promise<EveProjectContext> {
  const resolvedAppRoot = resolve(appRoot);
  const namedAgent = await resolveNamedAgentProjectContext(resolvedAppRoot);
  if (namedAgent !== undefined) return namedAgent;
  if (await hasVercelHostFramework(resolvedAppRoot)) {
    return { appRoot: resolvedAppRoot, kind: "standalone" };
  }
  const collection = await resolveAgentCollection(resolvedAppRoot);
  return collection === undefined
    ? { appRoot: resolvedAppRoot, kind: "standalone" }
    : { collection, kind: "collection" };
}
