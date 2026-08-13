import {
  createBundledRuntimeCompiledArtifactsSource,
  createDiskRuntimeCompiledArtifactsSource,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { readBundledCompiledArtifacts } from "#runtime/loaders/bundled-artifacts.js";
import { readDevelopmentRuntimeArtifactsSnapshotRoot } from "#internal/host/dev-runtime-artifacts.js";

/**
 * Configuration values needed to resolve the compiled-artifact source for
 * package-owned eve host routes. Passed explicitly to handlers rather than
 * read from a global runtime configuration store.
 */
export interface DevelopmentApplicationArtifactsConfig {
  readonly appRoot: string;
  readonly devRuntimeArtifactsPointerPath: string;
  /**
   * Set when durable Workflow payloads may store a logical generation
   * selector instead of this source's exact snapshot path. Only true when
   * the parent-owned dev World delivers the queue, because only those
   * deliveries install the context that resolves the selector.
   */
  readonly durableArtifactsReference?: "development-generation";
  readonly kind: "development";
  readonly moduleMapLoaderPath: string;
}

export interface ProductionApplicationArtifactsConfig {
  readonly kind: "production";
}

export type ApplicationArtifactsConfig =
  | DevelopmentApplicationArtifactsConfig
  | ProductionApplicationArtifactsConfig;

/**
 * Resolves the compiled-artifact source available to package-owned eve host
 * routes.
 */
export function resolveApplicationCompiledArtifactsSource(
  config: ApplicationArtifactsConfig,
): RuntimeCompiledArtifactsSource {
  if (config.kind === "development") {
    const runtimeAppRoot =
      readDevelopmentRuntimeArtifactsSnapshotRoot(config.devRuntimeArtifactsPointerPath) ??
      config.appRoot;

    return createDiskRuntimeCompiledArtifactsSource(runtimeAppRoot, {
      durableReference: config.durableArtifactsReference,
      moduleMapLoaderPath: config.moduleMapLoaderPath,
      sandboxAppRoot: config.appRoot,
    });
  }

  if (readBundledCompiledArtifacts() !== null) {
    return createBundledRuntimeCompiledArtifactsSource();
  }

  throw new Error("eve production host requires bundled artifacts.");
}
