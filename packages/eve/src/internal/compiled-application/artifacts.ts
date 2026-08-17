import type { CompiledAgentManifest } from "#internal/compiled-application/manifest.js";
import type { CompileMetadata } from "#internal/compiled-application/metadata.js";
import type { CompiledModuleMap } from "#internal/compiled-application/module-map.js";

/** Complete compiled artifact snapshot embedded in a runtime bundle. */
export interface BundledCompiledApplicationArtifacts {
  readonly manifest: CompiledAgentManifest;
  readonly metadata?: CompileMetadata;
  readonly moduleMap: CompiledModuleMap;
}

/** Artifact values available through the compiled-application loader. */
export interface CompiledApplicationArtifacts {
  readonly manifest: CompiledAgentManifest;
  readonly metadata: CompileMetadata | null;
  readonly moduleMap: CompiledModuleMap;
}
