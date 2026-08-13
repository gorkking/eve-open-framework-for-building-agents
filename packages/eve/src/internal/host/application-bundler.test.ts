import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveApplicationBundleConditionNames } from "#internal/host/application-bundler.js";

describe("resolveApplicationBundleConditionNames", () => {
  it("selects live vendored assets while bundling from package source", () => {
    const packageRoot = join("repo", "packages", "eve");

    expect(
      resolveApplicationBundleConditionNames(
        packageRoot,
        join(packageRoot, "src", "internal", "host", "application-bundler.ts"),
      ),
    ).toEqual(["eve-source", "node", "import", "default"]);
  });

  it("keeps built execution on the published compiled asset tree", () => {
    const packageRoot = join("repo", "packages", "eve");

    expect(
      resolveApplicationBundleConditionNames(
        packageRoot,
        join(packageRoot, "dist", "src", "internal", "host", "application-bundler.js"),
      ),
    ).toEqual(["node", "import", "default"]);
  });
});
