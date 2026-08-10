import { readdir, readFile, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { findClaimingAncestorPnpmWorkspaceRoot } from "#setup/primitives/pm/pnpm.js";
import { workspacePatternsClaimProject } from "#setup/scaffold/workspace-glob.js";

const AGENTS_DIRECTORY = "agents";
const DEPLOYMENT_AGENT_NAME_PATTERN = /^[a-z](?:[a-z_-]*[a-z])?$/;
const MAX_DEPLOYMENT_AGENT_NAME_LENGTH = 60;

export interface AgentCollectionMember {
  readonly appRoot: string;
  readonly name: string;
  readonly packageJsonPath?: string;
}

export interface AgentCollection {
  readonly members: readonly AgentCollectionMember[];
  readonly mode: "authored" | "inferred";
  readonly root: string;
}

async function pathKind(path: string): Promise<"directory" | "file" | undefined> {
  try {
    const entry = await stat(path);
    if (entry.isDirectory()) return "directory";
    if (entry.isFile()) return "file";
    return undefined;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function readJsonObject(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${path} must contain a JSON object.`);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

function packageJsonWorkspacePatterns(value: Record<string, unknown>): readonly string[] {
  const workspaces = value.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.filter((entry): entry is string => typeof entry === "string");
  }
  if (
    typeof workspaces === "object" &&
    workspaces !== null &&
    !Array.isArray(workspaces) &&
    "packages" in workspaces &&
    Array.isArray(workspaces.packages)
  ) {
    return workspaces.packages.filter((entry): entry is string => typeof entry === "string");
  }
  return [];
}

async function isWorkspaceMember(
  packageManager: PackageManagerKind,
  collectionRoot: string,
  memberRoot: string,
): Promise<boolean> {
  if (packageManager === "pnpm") {
    return (
      resolve(findClaimingAncestorPnpmWorkspaceRoot(memberRoot) ?? "") === resolve(collectionRoot)
    );
  }

  const packageJson = await readJsonObject(join(collectionRoot, "package.json"));
  return (
    packageJson !== undefined &&
    workspacePatternsClaimProject(
      packageJsonWorkspacePatterns(packageJson),
      collectionRoot,
      memberRoot,
    )
  );
}

function assertDeploymentAgentName(name: string): void {
  if (name.length > MAX_DEPLOYMENT_AGENT_NAME_LENGTH || !DEPLOYMENT_AGENT_NAME_PATTERN.test(name)) {
    throw new Error(
      `Agent collection member ${JSON.stringify(name)} cannot be a Vercel service name. Use 1-${MAX_DEPLOYMENT_AGENT_NAME_LENGTH} lowercase letters, hyphens, or underscores, beginning and ending with a letter.`,
    );
  }
}

/** Resolve a strict, direct-child `agents/<name>/agent/` collection at `root`. */
export async function resolveAgentCollection(root: string): Promise<AgentCollection | undefined> {
  const collectionRoot = resolve(root);
  const agentsRoot = join(collectionRoot, AGENTS_DIRECTORY);
  if ((await pathKind(agentsRoot)) !== "directory") return undefined;
  if ((await pathKind(join(collectionRoot, "package.json"))) !== "file") {
    throw new Error("An eve agent collection requires package.json at the collection root.");
  }
  if ((await pathKind(join(collectionRoot, "agent"))) === "directory") {
    throw new Error(
      "An eve project cannot contain both root agent/ and agents/. Move the root agent under agents/<name>/ or remove the collection.",
    );
  }

  const entries = (await readdir(agentsRoot, { withFileTypes: true }))
    .filter((entry) => !entry.name.startsWith("."))
    .sort((left, right) => left.name.localeCompare(right.name));
  const directories = entries.filter((entry) => entry.isDirectory());
  if (directories.length === 0) {
    throw new Error("The agents/ collection must contain at least one direct child agent.");
  }

  const packageManager = await detectPackageManager(collectionRoot);
  const members: AgentCollectionMember[] = [];
  for (const entry of directories) {
    assertDeploymentAgentName(entry.name);
    const appRoot = join(agentsRoot, entry.name);
    if ((await pathKind(join(appRoot, "agent"))) !== "directory") {
      const flatHint =
        (await pathKind(join(appRoot, "agent.ts"))) === "file"
          ? " Move flat authored files under an agent/ directory."
          : "";
      throw new Error(
        `${join(AGENTS_DIRECTORY, entry.name)} is not a collection agent: expected ${join(AGENTS_DIRECTORY, entry.name, "agent")}/.${flatHint}`,
      );
    }

    const packageJsonPath = join(appRoot, "package.json");
    const hasPackageJson = (await pathKind(packageJsonPath)) === "file";
    if (
      hasPackageJson &&
      !(await isWorkspaceMember(packageManager.kind, collectionRoot, appRoot))
    ) {
      throw new Error(
        `${join(AGENTS_DIRECTORY, entry.name, "package.json")} defines a child package that is not a member of the root ${packageManager.kind} workspace. Add agents/* to the workspace configuration.`,
      );
    }
    const member: { appRoot: string; name: string; packageJsonPath?: string } = {
      appRoot,
      name: entry.name,
    };
    if (hasPackageJson) member.packageJsonPath = packageJsonPath;
    members.push(member);
  }

  const vercelJson = await readJsonObject(join(collectionRoot, "vercel.json"));
  const hasAuthoredServices =
    vercelJson?.services !== undefined ||
    vercelJson?.experimentalServices !== undefined ||
    vercelJson?.experimentalServicesV2 !== undefined;

  return { members, mode: hasAuthoredServices ? "authored" : "inferred", root: collectionRoot };
}

/** Resolve the collection owning a strict direct child app root. */
export async function resolveOwningAgentCollection(
  appRoot: string,
): Promise<
  { readonly collection: AgentCollection; readonly member: AgentCollectionMember } | undefined
> {
  const resolvedAppRoot = resolve(appRoot);
  const agentsRoot = dirname(resolvedAppRoot);
  if (basename(agentsRoot) !== AGENTS_DIRECTORY) return undefined;
  const collection = await resolveAgentCollection(dirname(agentsRoot));
  const member = collection?.members.find((candidate) => candidate.appRoot === resolvedAppRoot);
  return collection === undefined || member === undefined ? undefined : { collection, member };
}
