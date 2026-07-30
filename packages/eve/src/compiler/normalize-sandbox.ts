import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { SandboxSourceRef } from "#discover/manifest.js";
import type { CompiledSandboxDefinition } from "#compiler/manifest.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import { getAuthoredModuleExport } from "#internal/authored-module.js";
import { isSandboxDefinition } from "#public/definitions/sandbox.js";
import { isSandboxTemplate } from "#shared/sandbox-template.js";
import type { ModuleBackedDefinitionLoadOptions } from "#compiler/normalize-helpers.js";

/**
 * Compiles sandbox module metadata without invoking the authored definition.
 *
 * The default export is session-dependent runtime code. Build only validates
 * its brand and discovers named template exports that can be prewarmed safely.
 */
export async function compileSandboxDefinition(
  agentRoot: string,
  source: SandboxSourceRef,
  options: ModuleBackedDefinitionLoadOptions = {},
): Promise<CompiledSandboxDefinition> {
  const moduleNamespace = await loadAuthoredModuleNamespace(join(agentRoot, source.logicalPath), {
    externalDependencies: options.externalDependencies,
  });
  const definition = getAuthoredModuleExport(moduleNamespace, source);

  if (!isSandboxDefinition(definition)) {
    throw new Error(
      `Expected the sandbox export "${source.exportName ?? "default"}" from "${source.logicalPath}" to be created with defineSandbox((ctx) => sandbox).`,
    );
  }

  const templateExports = Object.entries(moduleNamespace)
    .filter(([exportName, value]) => exportName !== "default" && isSandboxTemplate(value))
    .map(([exportName]) => exportName)
    .sort();

  return {
    exportName: source.exportName,
    logicalPath: source.logicalPath,
    sourceHash: await resolveSandboxSourceHash(agentRoot, source),
    sourceId: source.sourceId,
    sourceKind: "module",
    templateExports,
    templateReferences: {},
  };
}

async function resolveSandboxSourceHash(
  agentRoot: string,
  source: SandboxSourceRef,
): Promise<string> {
  const content = await readFile(join(agentRoot, source.logicalPath));
  return createHash("sha256").update(content).digest("hex");
}
