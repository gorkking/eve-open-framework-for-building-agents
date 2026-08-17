import { describe, expect, it } from "vitest";

import { resolveCompiledApplicationPaths } from "#internal/compiled-application/paths.js";

describe("resolveCompiledApplicationPaths", () => {
  it("resolves the default compiled application layout", () => {
    expect(resolveCompiledApplicationPaths("/app/")).toEqual({
      appRoot: "/app",
      compiledManifestPath: "/app/.eve/compile/compiled-agent-manifest.json",
      compileDirectoryPath: "/app/.eve/compile",
      compileMetadataPath: "/app/.eve/compile/compile-metadata.json",
      diagnosticsPath: "/app/.eve/discovery/diagnostics.json",
      discoveryManifestPath: "/app/.eve/discovery/agent-discovery-manifest.json",
      discoveryDirectoryPath: "/app/.eve/discovery",
      moduleMapPath: "/app/.eve/compile/module-map.mjs",
    });
  });

  it("supports a caller-owned artifact root", () => {
    const paths = resolveCompiledApplicationPaths("/app", "/tmp/generation/");

    expect(paths.appRoot).toBe("/app");
    expect(paths.compileDirectoryPath).toBe("/tmp/generation/compile");
    expect(paths.discoveryDirectoryPath).toBe("/tmp/generation/discovery");
  });

  it("normalizes Windows separators", () => {
    const paths = resolveCompiledApplicationPaths("C:\\workspace\\app\\");

    expect(paths.appRoot).toBe("C:/workspace/app");
    expect(paths.moduleMapPath).toBe("C:/workspace/app/.eve/compile/module-map.mjs");
  });
});
