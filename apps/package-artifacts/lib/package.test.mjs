import { describe, expect, test } from "vitest";

import {
  packageArtifactPath,
  packageDependencyUrl,
  packageManifestPath,
  packageVersion,
  preparePackageJson,
  previewPackageDependencyUrl,
} from "./package.mjs";

const sha = "a".repeat(40);

describe("package artifacts", () => {
  test("derives main and preview build versions", () => {
    expect(packageVersion("0.33.0", sha)).toBe(`0.33.0+main.${sha}`);
    expect(packageVersion("0.33.0", sha, "preview")).toBe(`0.33.0+preview.${sha}`);
  });

  test("derives immutable trusted and deployment-local preview URLs", () => {
    expect(packageArtifactPath(sha)).toBe(`packages/${sha}/eve.tgz`);
    expect(packageManifestPath(sha)).toBe(`packages/${sha}/manifest.json`);
    expect(packageDependencyUrl("https://packages.example.com", sha)).toBe(
      `https://packages.example.com/${sha}/eve.tgz`,
    );
    expect(previewPackageDependencyUrl("https://preview.example.com")).toBe(
      "https://preview.example.com/eve.tgz",
    );
  });

  test("requires an HTTPS package base URL", () => {
    expect(() => packageDependencyUrl("http://packages.example.com", sha)).toThrow(
      "must use HTTPS",
    );
  });

  test("prepares package metadata without mutating the source", () => {
    const source = { name: "eve", version: "0.33.0" };
    expect(preparePackageJson(source, sha, "preview")).toEqual({
      name: "eve",
      version: `0.33.0+preview.${sha}`,
    });
    expect(source.version).toBe("0.33.0");
  });

  test("rejects non-stable source versions", () => {
    expect(() => packageVersion("0.33.1-main.1", sha)).toThrow("Expected a stable eve version");
  });
});
