import { describe, expect, it } from "vitest";

import {
  createDiscoverErrorDiagnostic,
  createDiscoverWarningDiagnostic,
} from "../src/discover/diagnostics.js";
import {
  AGENT_SOURCE_MANIFEST_KIND,
  AGENT_SOURCE_MANIFEST_VERSION,
  createAgentSourceManifest,
  createModuleSourceRef,
  createPathDerivedSourceId,
  deriveAgentIdFromRoots,
} from "../src/discover/manifest.js";

describe("agent source manifest", () => {
  it("creates an empty manifest with stable defaults for nested agent roots", () => {
    const appRoot = "/tmp/weather-agent";
    const agentRoot = "/tmp/weather-agent/agent";

    expect(
      createAgentSourceManifest({
        agentRoot,
        appRoot,
      }),
    ).toEqual({
      agentId: "weather-agent",
      agentRoot,
      appRoot,
      channels: [],
      connections: [],
      diagnosticsSummary: {
        errors: 0,
        warnings: 0,
      },
      extensions: [],
      resolvedExtensions: [],
      hooks: [],
      instructions: [],
      lib: [],
      kind: AGENT_SOURCE_MANIFEST_KIND,
      memories: [],
      sandbox: null,
      sandboxWorkspaces: [],
      schedules: [],
      skills: [],
      tools: [],
      version: AGENT_SOURCE_MANIFEST_VERSION,
      subagents: [],
    });
  });

  it("preserves diagnostics summary for invalid fixture shapes without blocking manifest construction", () => {
    const appRoot = "/tmp/weather-agent";
    const agentRoot = "/tmp/weather-agent/agent";

    const manifest = createAgentSourceManifest({
      agentRoot,
      appRoot,
      diagnostics: [
        createDiscoverErrorDiagnostic({
          code: "discover/missing-instructions",
          message: "Expected instructions.md or instructions.ts in the agent root.",
          sourcePath: agentRoot,
        }),
        createDiscoverWarningDiagnostic({
          code: "discover/unsupported-entry",
          message: "Ignoring unsupported context/ directory.",
          sourcePath: `${agentRoot}/context`,
        }),
      ],
    });

    expect(manifest.diagnosticsSummary).toEqual({
      errors: 1,
      warnings: 1,
    });
  });

  it("preserves instructions and memory source refs together", () => {
    const manifest = createAgentSourceManifest({
      agentRoot: "/tmp/weather-agent/agent",
      appRoot: "/tmp/weather-agent",
      instructions: [createModuleSourceRef({ logicalPath: "instructions/context.ts" })],
      memories: [
        {
          ...createModuleSourceRef({ logicalPath: "memory/user.ts" }),
          slot: "user",
        },
      ],
    });

    expect(manifest.instructions).toEqual([
      {
        logicalPath: "instructions/context.ts",
        sourceId: "instructions/context.ts",
        sourceKind: "module",
      },
    ]);
    expect(manifest.memories).toEqual([
      {
        logicalPath: "memory/user.ts",
        slot: "user",
        sourceId: "memory/user.ts",
        sourceKind: "module",
      },
    ]);
  });

  it("derives stable agent ids and source ids from resolved paths", () => {
    expect(deriveAgentIdFromRoots("/tmp/weather-agent", "/tmp/weather-agent")).toBe(
      "weather-agent",
    );
    expect(deriveAgentIdFromRoots("/tmp/weather-agent", "/tmp/weather-agent/agent")).toBe(
      "weather-agent",
    );
    expect(createPathDerivedSourceId("context/my-location.md")).toBe("context/my-location.md");
  });

  it("prefers packageName over basename(appRoot) for flat layouts", () => {
    expect(deriveAgentIdFromRoots("/vercel/path0", "/vercel/path0", "my-agent")).toBe("my-agent");
  });

  it("prefers packageName over basename(appRoot) for nested layouts", () => {
    expect(deriveAgentIdFromRoots("/vercel/path0", "/vercel/path0/agent", "my-agent")).toBe(
      "my-agent",
    );
  });

  it("falls back to basename(appRoot) when packageName is undefined", () => {
    expect(deriveAgentIdFromRoots("/vercel/path0", "/vercel/path0")).toBe("path0");
    expect(deriveAgentIdFromRoots("/vercel/path0", "/vercel/path0/agent")).toBe("path0");
  });

  it("ignores packageName for non-standard agent root layouts", () => {
    expect(deriveAgentIdFromRoots("/tmp/app", "/tmp/app/agents/reviewer", "my-agent")).toBe(
      "reviewer",
    );
  });
});
