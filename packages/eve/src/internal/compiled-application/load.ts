import type { CompiledApplicationArtifacts } from "#internal/compiled-application/artifacts.js";
import { compiledAgentManifestSchema } from "#internal/compiled-application/manifest.js";
import { compileMetadataSchema } from "#internal/compiled-application/metadata.js";
import {
  compiledModuleMapSchema,
  type CompiledModuleMap,
} from "#internal/compiled-application/module-map.js";
import { resolveCompiledApplicationPaths } from "#internal/compiled-application/paths.js";
import { formatValidationError } from "#shared/validation.js";

export type CompiledApplicationArtifactName = keyof CompiledApplicationArtifacts;

export type CompiledApplicationSource =
  | {
      readonly appRoot: string;
      readonly kind: "disk";
    }
  | {
      readonly artifacts: unknown;
      readonly kind: "bundled";
    };

export class LoadCompiledApplicationArtifactError extends Error {
  readonly artifact: CompiledApplicationArtifactName;
  readonly source: string;

  constructor(input: {
    readonly artifact: CompiledApplicationArtifactName;
    readonly message: string;
    readonly source: string;
  }) {
    super(input.message);
    this.name = "LoadCompiledApplicationArtifactError";
    this.artifact = input.artifact;
    this.source = input.source;
  }
}

/** Loads only the selected artifacts from one compiled application source. */
export async function loadCompiledApplicationArtifacts<
  const Names extends readonly CompiledApplicationArtifactName[],
>(input: {
  readonly artifacts: Names;
  readonly source: CompiledApplicationSource;
}): Promise<Pick<CompiledApplicationArtifacts, Names[number]>> {
  const loaded: {
    -readonly [Name in keyof CompiledApplicationArtifacts]?: CompiledApplicationArtifacts[Name];
  } = {};

  await Promise.all(
    input.artifacts.map(async (artifact) => {
      if (artifact === "manifest") {
        loaded.manifest = await loadArtifact("manifest", input.source);
      } else if (artifact === "metadata") {
        loaded.metadata = await loadArtifact("metadata", input.source);
      } else {
        loaded.moduleMap = await loadArtifact("moduleMap", input.source);
      }
    }),
  );

  return loaded as Pick<CompiledApplicationArtifacts, Names[number]>;
}

async function loadArtifact<Name extends CompiledApplicationArtifactName>(
  artifact: Name,
  source: CompiledApplicationSource,
): Promise<CompiledApplicationArtifacts[Name]> {
  if (source.kind === "bundled") {
    return loadBundledArtifact(artifact, source.artifacts);
  }

  const paths = resolveCompiledApplicationPaths(source.appRoot);
  const artifactPath =
    artifact === "manifest"
      ? paths.compiledManifestPath
      : artifact === "metadata"
        ? paths.compileMetadataPath
        : paths.moduleMapPath;

  if (artifact === "moduleMap") {
    return (await loadDiskModuleMap(artifactPath)) as CompiledApplicationArtifacts[Name];
  }

  const value = await readJsonArtifact(artifact, artifactPath);
  return parseArtifact(artifact, value, artifactPath);
}

function loadBundledArtifact<Name extends CompiledApplicationArtifactName>(
  artifact: Name,
  artifacts: unknown,
): CompiledApplicationArtifacts[Name] {
  if (artifacts === null) {
    if (artifact === "metadata") return null as CompiledApplicationArtifacts[Name];
    throw new LoadCompiledApplicationArtifactError({
      artifact,
      message: `Compiled ${artifactLabel(artifact)} is unavailable without an app root or bundled compiled artifacts.`,
      source: bundledSourceLabel(artifact),
    });
  }

  const artifactRecord = isRecord(artifacts) ? artifacts : {};
  if (artifact === "metadata" && artifactRecord.metadata === undefined) {
    return null as CompiledApplicationArtifacts[Name];
  }

  const value = artifactRecord[artifact];
  return parseArtifact(artifact, value, bundledSourceLabel(artifact));
}

async function readJsonArtifact(
  artifact: "manifest" | "metadata",
  artifactPath: string,
): Promise<unknown> {
  const { readFile } = await import("node:fs/promises");

  try {
    return JSON.parse(await readFile(artifactPath, "utf8"));
  } catch (error) {
    throw new LoadCompiledApplicationArtifactError({
      artifact,
      message: error instanceof Error ? error.message : `Unknown ${artifact} load failure.`,
      source: artifactPath,
    });
  }
}

async function loadDiskModuleMap(moduleMapPath: string): Promise<CompiledModuleMap> {
  try {
    const moduleNamespace = (await import(createFileImportSpecifier(moduleMapPath))) as {
      default?: unknown;
      moduleMap?: unknown;
    };
    return parseArtifact(
      "moduleMap",
      moduleNamespace.moduleMap ?? moduleNamespace.default,
      moduleMapPath,
    );
  } catch (error) {
    if (error instanceof LoadCompiledApplicationArtifactError) throw error;
    throw new LoadCompiledApplicationArtifactError({
      artifact: "moduleMap",
      message: error instanceof Error ? error.message : "Unknown module-map load failure.",
      source: moduleMapPath,
    });
  }
}

function parseArtifact<Name extends CompiledApplicationArtifactName>(
  artifact: Name,
  value: unknown,
  source: string,
): CompiledApplicationArtifacts[Name] {
  if (artifact === "metadata" && value === null) {
    return null as CompiledApplicationArtifacts[Name];
  }

  const parsed =
    artifact === "manifest"
      ? compiledAgentManifestSchema.safeParse(value)
      : artifact === "metadata"
        ? compileMetadataSchema.safeParse(value)
        : compiledModuleMapSchema.safeParse(value);

  if (!parsed.success) {
    throw new LoadCompiledApplicationArtifactError({
      artifact,
      message: `Expected "${source}" to contain ${validArtifactDescription(artifact)}. ${formatValidationError(parsed.error)}`,
      source,
    });
  }

  return parsed.data as CompiledApplicationArtifacts[Name];
}

function validArtifactDescription(artifact: CompiledApplicationArtifactName): string {
  if (artifact === "manifest") return "a valid compiled eve agent manifest";
  if (artifact === "metadata") return "valid eve compile metadata";
  return "a valid compiled eve module map";
}

function artifactLabel(artifact: CompiledApplicationArtifactName): string {
  if (artifact === "moduleMap") return "module map";
  if (artifact === "metadata") return "metadata";
  return "manifest";
}

function bundledSourceLabel(artifact: CompiledApplicationArtifactName): string {
  return `bundled compiled ${artifactLabel(artifact)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function createFileImportSpecifier(moduleMapPath: string): string {
  const normalizedPath = moduleMapPath.replaceAll("\\", "/");

  if (/^[A-Za-z]:\//.test(normalizedPath)) {
    return `file:///${encodeURI(normalizedPath)}`;
  }

  if (normalizedPath.startsWith("/")) {
    return `file://${encodeURI(normalizedPath)}`;
  }

  return normalizedPath;
}
