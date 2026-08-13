import { copyFile, cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { materializeAuthoredModules } from "#internal/materialized-authored-modules.js";

export async function stageProductionCompilerArtifacts(input: {
  readonly compilerRoot: string;
  readonly outputDir: string;
}): Promise<void> {
  const materialized = await materializeAuthoredModules({
    runtimeAppRoot: input.compilerRoot,
  });
  const compilerArtifactsRoot = join(input.compilerRoot, ".eve");
  const destinationDirectory = join(input.outputDir, ".eve");

  await mkdir(dirname(destinationDirectory), { recursive: true });
  await cp(compilerArtifactsRoot, destinationDirectory, { recursive: true });
  await copyFile(
    join(destinationDirectory, "compile", materialized.moduleMap),
    join(destinationDirectory, "compile", "module-map.mjs"),
  );
}
