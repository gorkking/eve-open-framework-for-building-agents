import { beforeEach, describe, expect, it, vi } from "vitest";

const importState = vi.hoisted(() => ({
  protocol: 1,
}));

vi.mock("@eve/build", () => ({
  get EVE_BUILD_ENGINE_PROTOCOL() {
    return importState.protocol;
  },
}));

describe("loadBuildEngine", () => {
  beforeEach(() => {
    importState.protocol = 1;
    vi.resetModules();
  });

  it("loads a compatible project-local engine", async () => {
    const { loadBuildEngine } = await import("./build-engine.js");

    await expect(loadBuildEngine()).resolves.toMatchObject({ EVE_BUILD_ENGINE_PROTOCOL: 1 });
  });

  it("rejects an incompatible engine protocol", async () => {
    importState.protocol = 2;
    const { loadBuildEngine } = await import("./build-engine.js");

    await expect(loadBuildEngine()).rejects.toThrow(
      "Incompatible @eve/build protocol 2; eve requires protocol 1",
    );
  });
});
