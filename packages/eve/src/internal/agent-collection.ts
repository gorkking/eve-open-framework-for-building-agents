import { basename, dirname, join, resolve } from "node:path";

import { createDiskProjectSource, type ProjectSource } from "#discover/project-source.js";
import { detectPackageManager } from "#setup/package-manager.js";
import { packageManagerWorkspaceClaimsProject } from "#setup/scaffold/workspace-root.js";

const AGENTS_DIRECTORY = "agents";
const PUBLIC_AGENT_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9_-]*[a-z0-9])?$/;

export interface AgentCollectionMember {
  readonly appRoot: string;
  readonly name: string;
  readonly packageJsonPath?: string;
}

export interface AgentCollection {
  readonly members: readonly AgentCollectionMember[];
  readonly root: string;
}

/** Resolve a strict, direct-child `agents/<name>/agent/` collection at `root`. */
export async function resolveAgentCollection(
  root: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<AgentCollection | undefined> {
  const source = options.source ?? createDiskProjectSource();
  const collectionRoot = resolve(root);
  const agentsRoot = join(collectionRoot, AGENTS_DIRECTORY);
  if ((await source.stat(agentsRoot)) !== "directory") return undefined;
  if ((await source.stat(join(collectionRoot, "package.json"))) !== "file") {
    throw new Error("An eve agent collection requires package.json at the collection root.");
  }
  if ((await source.stat(join(collectionRoot, "agent"))) === "directory") {
    throw new Error(
      "An eve project cannot contain both root agent/ and agents/. Move the root agent under agents/<name>/ or remove the collection.",
    );
  }

  const entries = (await source.readDirectory(agentsRoot))
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 0) {
    throw new Error("The agents/ collection must contain at least one direct child agent.");
  }

  const packageManager =
    source.kind === "disk" ? await detectPackageManager(collectionRoot) : undefined;
  const members: AgentCollectionMember[] = [];
  for (const entry of directories) {
    if (!PUBLIC_AGENT_NAME_PATTERN.test(entry.name)) {
      throw new Error(
        `Agent collection member ${JSON.stringify(entry.name)} has an invalid public identity. Use lowercase letters, numbers, hyphens, or underscores, beginning and ending with a letter or number.`,
      );
    }
    const appRoot = join(agentsRoot, entry.name);
    if ((await source.stat(join(appRoot, "agent"))) !== "directory") {
      const flatHint =
        (await source.stat(join(appRoot, "agent.ts"))) === "file"
          ? " Move flat authored files under an agent/ directory."
          : "";
      throw new Error(
        `${join(AGENTS_DIRECTORY, entry.name)} is not a collection agent: expected ${join(AGENTS_DIRECTORY, entry.name, "agent")}/.${flatHint}`,
      );
    }

    const packageJsonPath = join(appRoot, "package.json");
    const hasPackageJson = (await source.stat(packageJsonPath)) === "file";
    if (
      source.kind === "disk" &&
      hasPackageJson &&
      !packageManagerWorkspaceClaimsProject(packageManager!.kind, collectionRoot, appRoot)
    ) {
      throw new Error(
        `${join(AGENTS_DIRECTORY, entry.name, "package.json")} defines a child package that is not a member of the root ${packageManager!.kind} workspace. Add agents/* to the workspace configuration.`,
      );
    }
    const member: { appRoot: string; name: string; packageJsonPath?: string } = {
      appRoot,
      name: entry.name,
    };
    if (hasPackageJson) member.packageJsonPath = packageJsonPath;
    members.push(member);
  }

  return { members, root: collectionRoot };
}

/** Resolve the collection owning a strict direct child app root. */
export async function resolveOwningAgentCollection(
  appRoot: string,
  options: { readonly source?: ProjectSource } = {},
): Promise<
  { readonly collection: AgentCollection; readonly member: AgentCollectionMember } | undefined
> {
  const resolvedAppRoot = resolve(appRoot);
  const agentsRoot = dirname(resolvedAppRoot);
  if (basename(agentsRoot) !== AGENTS_DIRECTORY) return undefined;
  const collection = await resolveAgentCollection(dirname(agentsRoot), options);
  const member = collection?.members.find((candidate) => candidate.appRoot === resolvedAppRoot);
  return collection === undefined || member === undefined ? undefined : { collection, member };
}
