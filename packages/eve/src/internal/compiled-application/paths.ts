export interface CompiledApplicationPaths {
  readonly appRoot: string;
  readonly compiledManifestPath: string;
  readonly compileDirectoryPath: string;
  readonly compileMetadataPath: string;
  readonly diagnosticsPath: string;
  readonly discoveryManifestPath: string;
  readonly discoveryDirectoryPath: string;
  readonly moduleMapPath: string;
}

/** Resolves the stable artifact layout shared by compilation and runtime loading. */
export function resolveCompiledApplicationPaths(
  appRoot: string,
  artifactsRoot: string = joinFilesystemPath(appRoot, ".eve"),
): CompiledApplicationPaths {
  const normalizedAppRoot = normalizeFilesystemPath(appRoot);
  const normalizedArtifactsRoot = normalizeFilesystemPath(artifactsRoot);
  const discoveryDirectoryPath = joinFilesystemPath(normalizedArtifactsRoot, "discovery");
  const compileDirectoryPath = joinFilesystemPath(normalizedArtifactsRoot, "compile");

  return {
    appRoot: normalizedAppRoot,
    compiledManifestPath: joinFilesystemPath(compileDirectoryPath, "compiled-agent-manifest.json"),
    compileDirectoryPath,
    compileMetadataPath: joinFilesystemPath(compileDirectoryPath, "compile-metadata.json"),
    diagnosticsPath: joinFilesystemPath(discoveryDirectoryPath, "diagnostics.json"),
    discoveryManifestPath: joinFilesystemPath(
      discoveryDirectoryPath,
      "agent-discovery-manifest.json",
    ),
    discoveryDirectoryPath,
    moduleMapPath: joinFilesystemPath(compileDirectoryPath, "module-map.mjs"),
  };
}

function joinFilesystemPath(base: string, segment: string): string {
  const normalizedBase = normalizeFilesystemPath(base);
  return normalizedBase === "/" ? `/${segment}` : `${normalizedBase}/${segment}`;
}

function normalizeFilesystemPath(path: string): string {
  const normalized = path.replaceAll("\\", "/");
  return normalized === "/" ? normalized : normalized.replace(/\/+$/, "");
}
