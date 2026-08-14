import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentWorkspace, AgentWorkspaceMember } from "#internal/agent-workspace.js";
import { assembleEveVercelServices } from "#internal/vercel/assemble-eve-services.js";
import { quoteVercelShellArgument, toVercelRelativePath } from "#internal/vercel/build-command.js";
import { resolveAgentWorkspaceDeploymentMode } from "#internal/vercel/agent-workspace-deployment.js";
import { resolveEveBinaryPath } from "#shared/resolve-eve-binary.js";
import { detectPackageManager, type PackageManagerKind } from "#setup/package-manager.js";
import { parseJsonObject } from "#shared/json.js";

const VERCEL_BUILD_OUTPUT_VERSION = 3;

async function hasBuildScript(member: AgentWorkspaceMember): Promise<boolean> {
  if (member.packageJsonPath === undefined) return false;

  const packageJson = parseJsonObject(JSON.parse(await readFile(member.packageJsonPath, "utf8")));
  if (packageJson.scripts === undefined) return false;
  const scripts = parseJsonObject(packageJson.scripts);
  return typeof scripts.build === "string";
}

async function resolveMemberBuildCommand(
  member: AgentWorkspaceMember,
  packageManager: PackageManagerKind,
): Promise<string> {
  if (await hasBuildScript(member)) return `${packageManager} run build`;

  return `node ${quoteVercelShellArgument(
    toVercelRelativePath(member.appRoot, resolveEveBinaryPath(member.appRoot)),
  )} build`;
}

/** Emit the inferred Vercel Services project for a strict hostless workspace. */
export async function buildAgentWorkspace(workspace: AgentWorkspace): Promise<string> {
  if ((await resolveAgentWorkspaceDeploymentMode(workspace)) === "authored") {
    throw new Error(
      "This project defines its Vercel service graph in vercel.json. Run `vercel build` to build the complete project, or run `eve build` from an individual agent directory.",
    );
  }

  const packageManager = await detectPackageManager(workspace.root);
  const agents = await Promise.all(
    workspace.members.map(async (member) => ({
      agent: {
        appRoot: member.appRoot,
        buildCommand: await resolveMemberBuildCommand(member, packageManager.kind),
        name: member.name,
        publicRoutePrefix: `/eve/agents/${member.name}`,
      },
      target: {
        hostOutputDirectory: join(workspace.root, ".vercel", "output"),
        projectRoot: workspace.root,
      },
    })),
  );
  const assembled = assembleEveVercelServices({ agents });

  const outputDirectory = join(workspace.root, ".vercel", "output");
  await rm(outputDirectory, { force: true, recursive: true });
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all(
    assembled.rootDirectories.map((rootDirectory) => mkdir(rootDirectory, { recursive: true })),
  );
  await writeFile(
    join(outputDirectory, "config.json"),
    `${JSON.stringify(
      {
        version: VERCEL_BUILD_OUTPUT_VERSION,
        routes: assembled.routes,
        services: assembled.services,
      },
      null,
      2,
    )}\n`,
  );
  return outputDirectory;
}
