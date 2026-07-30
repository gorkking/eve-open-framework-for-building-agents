import { describe, expect, it } from "vitest";

import { shouldPruneLocalSandboxEngines } from "#internal/nitro/host/create-application-nitro.js";

describe("shouldPruneLocalSandboxEngines", () => {
  it("prunes local engines when no authored definition can select one", () => {
    expect(
      shouldPruneLocalSandboxEngines({
        configuredProviders: new Set(),
        preset: "vercel",
      }),
    ).toBe(true);
  });

  it("keeps local backends when a local backend is configured explicitly", () => {
    for (const provider of ["docker", "microsandbox", "just-bash"]) {
      expect(
        shouldPruneLocalSandboxEngines({
          configuredProviders: new Set([provider]),
          preset: "vercel",
        }),
      ).toBe(false);
    }
  });

  it("still prunes local backends when only Vercel or custom backends are configured", () => {
    expect(
      shouldPruneLocalSandboxEngines({
        configuredProviders: new Set(["vercel", "custom"]),
        preset: "vercel",
      }),
    ).toBe(true);
  });

  it("does not prune local backends for non-Vercel presets", () => {
    expect(
      shouldPruneLocalSandboxEngines({
        configuredProviders: new Set(),
        preset: undefined,
      }),
    ).toBe(false);
  });
});
