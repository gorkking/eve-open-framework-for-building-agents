import {
  LoadCompiledApplicationArtifactError,
  loadCompiledApplicationArtifacts,
  type CompiledApplicationArtifactName,
} from "#internal/compiled-application/load.js";
import type { CompiledApplicationArtifacts } from "#internal/compiled-application/artifacts.js";
import type { CompiledAgentManifest } from "#internal/compiled-application/manifest.js";
import type { CompileMetadata } from "#internal/compiled-application/metadata.js";
import type { CompiledModuleMap } from "#internal/compiled-application/module-map.js";
import type { RuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";

/** Adapts a durable runtime source marker to the compiled-application loader. */
export async function loadRuntimeCompiledApplicationArtifacts<
  const Names extends readonly CompiledApplicationArtifactName[],
>(input: {
  readonly artifacts: Names;
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<Pick<CompiledApplicationArtifacts, Names[number]>> {
  return await loadCompiledApplicationArtifacts({
    artifacts: input.artifacts,
    source:
      input.compiledArtifactsSource.kind === "disk"
        ? { appRoot: input.compiledArtifactsSource.appRoot, kind: "disk" }
        : { artifacts: readBundledCompiledArtifacts(), kind: "bundled" },
  });
}

export const LoadCompiledManifestError = LoadCompiledApplicationArtifactError;
export const LoadCompiledModuleMapError = LoadCompiledApplicationArtifactError;

export async function loadCompiledManifest(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<CompiledAgentManifest> {
  return (
    await loadRuntimeCompiledApplicationArtifacts({
      artifacts: ["manifest"],
      compiledArtifactsSource: input.compiledArtifactsSource,
    })
  ).manifest;
}

export async function loadCompiledModuleMap(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<CompiledModuleMap> {
  return (
    await loadRuntimeCompiledApplicationArtifacts({
      artifacts: ["moduleMap"],
      compiledArtifactsSource: input.compiledArtifactsSource,
    })
  ).moduleMap;
}

export async function loadCompileMetadata(input: {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
}): Promise<CompileMetadata | null> {
  return (
    await loadRuntimeCompiledApplicationArtifacts({
      artifacts: ["metadata"],
      compiledArtifactsSource: input.compiledArtifactsSource,
    })
  ).metadata;
}
