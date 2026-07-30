import { describe, expect, it } from "vitest";

import type { CompiledSandboxDefinition } from "#compiler/manifest.js";
import { resolveSandboxDefinition } from "#runtime/resolve-sandbox.js";

const SELFMOD_SANDBOX: CompiledSandboxDefinition = {
  backendName: "eve-selfmod",
  description: "Development-only source editor.",
  logicalPath: "subagents/self-edit.ts",
  sourceHash: "selfmod-test",
  sourceId: "subagents/self-edit.ts",
  sourceKind: "module",
};

describe("resolveSandboxDefinition", () => {
  it("resolves selfmod without an authored module namespace", async () => {
    const resolved = await resolveSandboxDefinition(
      SELFMOD_SANDBOX,
      { nodes: {} },
      "subagents/self-edit.ts",
    );

    expect(resolved.backend.name).toBe("eve-selfmod");
  });
});
