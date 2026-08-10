import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import type { AgentCollection, AgentCollectionMember } from "#internal/agent-collection.js";
import { compileEveVercelService } from "#internal/vercel/eve-service-contribution.js";
import { resolveEveBinaryPath } from "#shared/resolve-eve-binary.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";

const VERCEL_BUILD_OUTPUT_VERSION = 3;

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function toPosixRelative(from: string, to: string): string {
  return relative(from, to).replaceAll("\\", "/") || ".";
}

async function hasBuildScript(member: AgentCollectionMember): Promise<boolean> {
  if (member.packageJsonPath === undefined) return false;
  const value = JSON.parse(await readFile(member.packageJsonPath, "utf8")) as unknown;
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "scripts" in value &&
    typeof value.scripts === "object" &&
    value.scripts !== null &&
    !Array.isArray(value.scripts) &&
    "build" in value.scripts &&
    typeof value.scripts.build === "string"
  );
}

function runBuildScriptCommand(packageManager: PackageManagerKind): string {
  switch (packageManager) {
    case "bun":
      return "bun run build";
    case "npm":
      return "npm run build";
    case "pnpm":
      return "pnpm run build";
    case "yarn":
      return "yarn run build";
  }
}

async function resolveMemberBuildCommand(
  collection: AgentCollection,
  member: AgentCollectionMember,
): Promise<string> {
  const packageManager = await detectPackageManager(collection.root);
  if (await hasBuildScript(member)) return runBuildScriptCommand(packageManager.kind);

  return `node ${quoteShellArgument(
    toPosixRelative(member.appRoot, resolveEveBinaryPath(member.appRoot)),
  )} build`;
}

/** Emit the inferred Vercel Services project for a strict hostless collection. */
export async function buildAgentCollection(collection: AgentCollection): Promise<string> {
  if (collection.mode === "authored") {
    throw new Error(
      "This project defines its Vercel service graph in vercel.json. Run `vercel build` to build the complete project, or run `eve build` from an individual agent directory.",
    );
  }

  const contributions = await Promise.all(
    collection.members.map(async (member) =>
      compileEveVercelService({
        agent: {
          appRoot: member.appRoot,
          buildCommand: await resolveMemberBuildCommand(collection, member),
          name: member.name,
          publicRoutePrefix: `/eve/agents/${member.name}`,
        },
        target: {
          kind: "direct",
          projectRoot: collection.root,
          root: toPosixRelative(collection.root, member.appRoot),
        },
      }),
    ),
  );

  const outputDirectory = join(collection.root, ".vercel", "output");
  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await writeFile(
    join(outputDirectory, "config.json"),
    `${JSON.stringify(
      {
        version: VERCEL_BUILD_OUTPUT_VERSION,
        routes: contributions.map((contribution) => contribution.publicRoute),
        services: Object.fromEntries(
          contributions.map((contribution) => [contribution.serviceName, contribution.service]),
        ),
      },
      null,
      2,
    )}\n`,
  );
  return outputDirectory;
}
