import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { PackageManagerKind } from "./package-manager.js";
import { findStrictlyClaimingAncestorPnpmWorkspaceRoot } from "./primitives/pm/pnpm.js";
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

function findStrictlyClaimingPackageJsonWorkspaceRoot(projectRoot: string): string | undefined {
  let dir = dirname(resolve(projectRoot));
  while (true) {
    const packageJsonPath = join(dir, "package.json");
    if (existsSync(packageJsonPath)) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(packageJsonPath, "utf8"));
        if (!isJsonObject(parsed)) continue;
        const patterns = packageJsonWorkspacePatterns(parsed as PackageJsonWorkspaceShape);
        if (patterns !== undefined && workspacePatternsClaimProject(patterns, dir, projectRoot)) {
          return dir;
        }
      } catch {
        // An unreadable workspace manifest cannot establish package membership.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Whether `projectRoot` is explicitly claimed by `workspaceRoot`. */
export function packageManagerWorkspaceClaimsProject(
  packageManager: PackageManagerKind,
  workspaceRoot: string,
  projectRoot: string,
): boolean {
  const claimingRoot =
    packageManager === "pnpm"
      ? findStrictlyClaimingAncestorPnpmWorkspaceRoot(projectRoot)
      : findStrictlyClaimingPackageJsonWorkspaceRoot(projectRoot);
  return claimingRoot !== undefined && resolve(claimingRoot) === resolve(workspaceRoot);
}
