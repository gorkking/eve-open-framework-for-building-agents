import { describe, expect, test } from "vitest";

import {
  packageArtifactPath,
  packageDependencyUrl,
  packageManifestPath,
  packageVersion,
  preparePackageJson,
  unverifiedPackageArtifactPath,
  unverifiedPackageManifestPath,
  unverifiedPullRequestManifestPath,
} from "./package.mjs";

const sha = "a".repeat(40);

describe("package artifacts", () => {
  test("derives trusted and unverified build versions", () => {
    expect(packageVersion("0.33.0", sha)).toBe(`0.33.0+main.${sha}`);
    expect(packageVersion("0.33.0", sha, "unverified")).toBe(`0.33.0+unverified.${sha}`);
  });

  test("derives immutable trusted and unverified artifact URLs", () => {
    expect(packageArtifactPath(sha)).toBe(`packages/${sha}/eve.tgz`);
    expect(packageManifestPath(sha)).toBe(`packages/${sha}/manifest.json`);
    expect(packageDependencyUrl("https://packages.example.com", sha)).toBe(
      `https://packages.example.com/${sha}/eve.tgz`,
    );
    expect(unverifiedPackageArtifactPath(sha)).toBe(`unverified/sha/${sha}/eve.tgz`);
    expect(unverifiedPackageManifestPath(sha)).toBe(`unverified/sha/${sha}/manifest.json`);
    expect(unverifiedPullRequestManifestPath("123")).toBe("unverified/pr/123/latest.json");
    expect(packageDependencyUrl("https://packages.example.com", sha, "unverified")).toBe(
      `https://packages.example.com/unverified/sha/${sha}/eve.tgz`,
    );
  });

  test("requires an HTTPS package base URL and a positive pull request number", () => {
    expect(() => packageDependencyUrl("http://packages.example.com", sha)).toThrow(
      "must use HTTPS",
    );
    expect(() => unverifiedPullRequestManifestPath("0")).toThrow("positive integer");
  });

  test("prepares package metadata without mutating the source", () => {
    const source = { name: "eve", version: "0.33.0" };
    expect(preparePackageJson(source, sha, "unverified")).toEqual({
      name: "eve",
      version: `0.33.0+unverified.${sha}`,
    });
    expect(source.version).toBe("0.33.0");
  });

  test("rejects non-stable source versions", () => {
    expect(() => packageVersion("0.33.1-main.1", sha)).toThrow("Expected a stable eve version");
  });
});
