import { describe, expect, it } from "vitest";

import type { BundledCompiledApplicationArtifacts } from "#internal/compiled-application/artifacts.js";
import { loadCompiledApplicationArtifacts } from "#internal/compiled-application/load.js";
import { createCompiledAgentManifest } from "#internal/compiled-application/manifest.js";

function createArtifacts(): BundledCompiledApplicationArtifacts {
  return {
    manifest: createCompiledAgentManifest({
      agentRoot: "/app/agent",
      appRoot: "/app",
      config: {
        model: {
          id: "openai/gpt-5-mini",
          routing: { kind: "gateway", target: "openai" },
        },
        name: "test-agent",
      },
    }),
    moduleMap: { nodes: {} },
  };
}

describe("loadCompiledApplicationArtifacts", () => {
  it("loads only selected bundled artifacts", async () => {
    const artifacts = createArtifacts();

    await expect(
      loadCompiledApplicationArtifacts({
        artifacts: ["manifest"],
        source: {
          artifacts: { ...artifacts, moduleMap: { nodes: null } },
          kind: "bundled",
        },
      }),
    ).resolves.toEqual({ manifest: artifacts.manifest });
  });

  it("returns null when bundled metadata is absent", async () => {
    await expect(
      loadCompiledApplicationArtifacts({
        artifacts: ["metadata"],
        source: { artifacts: createArtifacts(), kind: "bundled" },
      }),
    ).resolves.toEqual({ metadata: null });
  });

  it("identifies the selected artifact when validation fails", async () => {
    const artifacts = createArtifacts();

    await expect(
      loadCompiledApplicationArtifacts({
        artifacts: ["moduleMap"],
        source: {
          artifacts: {
            ...artifacts,
            moduleMap: { nodes: null },
          },
          kind: "bundled",
        },
      }),
    ).rejects.toMatchObject({
      artifact: "moduleMap",
      source: "bundled compiled module map",
    });
  });
});
