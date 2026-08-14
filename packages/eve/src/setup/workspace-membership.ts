import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { PackageManagerKind } from "./package-manager.js";
import {
  findAncestorPnpmWorkspaceRoot,
  findStrictlyClaimingAncestorPnpmWorkspaceRoot,
} from "./primitives/pm/pnpm.js";
import { workspacePatternsClaimProject } from "./scaffold/workspace-glob.js";

interface PackageJsonWorkspaceShape {
  workspaces?: unknown;
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function packageJsonWorkspacePatterns(
  packageJson: PackageJsonWorkspaceShape,
): string[] | undefined {
  const workspaces = packageJson.workspaces;
  if (Array.isArray(workspaces)) {
    return workspaces.every((entry) => typeof entry === "string") ? workspaces : undefined;
  }
  if (!isJsonObject(workspaces) || !Array.isArray(workspaces.packages)) return undefined;
  return workspaces.packages.every((entry) => typeof entry === "string")
    ? workspaces.packages
    : undefined;
}

function readPackageJsonWorkspacePatterns(packageJsonPath: string): string[] | undefined {
  const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return isJsonObject(parsed)
    ? packageJsonWorkspacePatterns(parsed as PackageJsonWorkspaceShape)
    : undefined;
}

/** Finds the nearest ancestor with an explicit package.json workspace declaration. */
export function findAncestorPackageJsonWorkspaceRoot(projectRoot: string): string | undefined {
  let dir = dirname(resolve(projectRoot));
  while (true) {
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        if ((readPackageJsonWorkspacePatterns(packageJsonPath)?.length ?? 0) > 0) return dir;
      } catch {
        // Keep walking; an unreadable package.json is not a reliable workspace owner.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Finds the nearest package.json workspace that explicitly claims `projectRoot`. */
export function findClaimingPackageJsonWorkspaceRoot(projectRoot: string): string | undefined {
  const workspaceRoot = findAncestorPackageJsonWorkspaceRoot(projectRoot);
  if (workspaceRoot === undefined) return undefined;

  try {
    const patterns = readPackageJsonWorkspacePatterns(join(workspaceRoot, "package.json"));
    return patterns !== undefined &&
      workspacePatternsClaimProject(patterns, workspaceRoot, projectRoot)
      ? workspaceRoot
      : undefined;
  } catch {
    return undefined;
  }
}

/** Finds the ancestor workspace that owns package-manager root-only configuration. */
export function findPackageManagerWorkspaceRoot(
  packageManager: PackageManagerKind,
  projectRoot: string,
): string | undefined {
  switch (packageManager) {
    case "pnpm":
      return findAncestorPnpmWorkspaceRoot(projectRoot);
    case "bun":
    case "npm":
    case "yarn":
      return findAncestorPackageJsonWorkspaceRoot(projectRoot);
  }
}

/** Finds the workspace that explicitly claims `projectRoot`. */
export function findClaimingPackageManagerWorkspaceRoot(
  packageManager: PackageManagerKind,
  projectRoot: string,
): string | undefined {
  return packageManager === "pnpm"
    ? findStrictlyClaimingAncestorPnpmWorkspaceRoot(projectRoot)
    : findClaimingPackageJsonWorkspaceRoot(projectRoot);
}

/** Whether `projectRoot` is explicitly claimed by `workspaceRoot`. */
export function packageManagerWorkspaceClaimsProject(
  packageManager: PackageManagerKind,
  workspaceRoot: string,
  projectRoot: string,
): boolean {
  const claimingRoot = findClaimingPackageManagerWorkspaceRoot(packageManager, projectRoot);
  return claimingRoot !== undefined && resolve(claimingRoot) === resolve(workspaceRoot);
}
