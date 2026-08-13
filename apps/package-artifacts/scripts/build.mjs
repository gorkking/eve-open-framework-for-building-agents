import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { get, put } from "@vercel/blob";

import {
  SHA_PATTERN,
  packageArtifactPath,
  packageDependencyUrl,
  packageManifestPath,
  preparePackageJson,
} from "../lib/package.mjs";
import { packPackage } from "../lib/pack.mjs";
const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const evePackageRoot = join(repoRoot, "packages/eve");
const evePackageJsonPath = join(evePackageRoot, "package.json");
const buildPackageRoot = join(repoRoot, "packages/eve-build");
const buildPackageJsonPath = join(buildPackageRoot, "package.json");
const artifactDirectory = join(appRoot, ".artifacts");
const sourceSha = process.env.VERCEL_GIT_COMMIT_SHA;
const branch = process.env.VERCEL_GIT_COMMIT_REF;
const productionDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL;

if (!SHA_PATTERN.test(sourceSha ?? "")) {
  throw new Error("VERCEL_GIT_COMMIT_SHA must be a 40-character Git commit SHA.");
}
if (branch !== "main" || process.env.VERCEL_ENV !== "production") {
  await mkdir(join(appRoot, "public"), { recursive: true });
  await writeFile(
    join(appRoot, "public/index.html"),
    "<!doctype html><title>eve packages</title><p>Artifacts are only published from main.</p>\n",
  );
  process.exit(0);
}

if (typeof productionDomain !== "string" || productionDomain.length === 0) {
  throw new Error("VERCEL_PROJECT_PRODUCTION_URL is required for package publishing.");
}

const originalEvePackageJson = await readFile(evePackageJsonPath, "utf8");
const originalBuildPackageJson = await readFile(buildPackageJsonPath, "utf8");
const preparedEvePackageJson = preparePackageJson(JSON.parse(originalEvePackageJson), sourceSha);
const preparedBuildPackageJson = preparePackageJson(
  JSON.parse(originalBuildPackageJson),
  sourceSha,
);
const version = preparedEvePackageJson.version;
// Generated projects pin this deployment's immutable SHA route, never the moving main route.
const dependencyUrl = packageDependencyUrl(`https://${productionDomain}`, sourceSha);
const buildDependencyUrl = packageDependencyUrl(
  `https://${productionDomain}`,
  sourceSha,
  "eve-build",
);
const artifactPath = packageArtifactPath(sourceSha);
const buildArtifactPath = packageArtifactPath(sourceSha, "eve-build");

async function publishArtifact(path, tarball) {
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  try {
    await put(path, tarball, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 31_536_000,
      contentType: "application/gzip",
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    const publishedArtifact = await get(path, { access: "private", useCache: false });
    if (publishedArtifact === null) {
      throw new Error("Published package artifact could not be read.");
    }
    const publishedSha256 = createHash("sha256")
      .update(Buffer.from(await new Response(publishedArtifact.stream).arrayBuffer()))
      .digest("hex");
    if (publishedSha256 !== sha256) {
      throw new Error(`Commit ${sourceSha} was already published with different package contents.`);
    }
  }
  return sha256;
}

try {
  await rm(artifactDirectory, { force: true, recursive: true });
  await writeFile(evePackageJsonPath, `${JSON.stringify(preparedEvePackageJson, null, 2)}\n`);
  await writeFile(buildPackageJsonPath, `${JSON.stringify(preparedBuildPackageJson, null, 2)}\n`);
  const buildTarball = await packPackage(buildPackageRoot, preparedBuildPackageJson.version);
  const tarball = await packPackage(evePackageRoot, version, {
    ...process.env,
    EVE_BUILD_DEPENDENCY_URL: buildDependencyUrl,
    EVE_MAIN_DEPENDENCY_URL: dependencyUrl,
  });
  const [buildSha256, sha256] = await Promise.all([
    publishArtifact(buildArtifactPath, buildTarball),
    publishArtifact(artifactPath, tarball),
  ]);

  const manifest = {
    sourceSha,
    version,
    tarball: dependencyUrl,
    sha256,
    buildTarball: buildDependencyUrl,
    buildSha256,
  };
  const manifestPath = packageManifestPath(sourceSha);
  const existingManifest = await get(manifestPath, { access: "private", useCache: false });
  if (existingManifest === null) {
    await put(manifestPath, JSON.stringify(manifest), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 31_536_000,
      contentType: "application/json",
    });
  } else {
    const published = JSON.parse(await new Response(existingManifest.stream).text());
    if (published.sha256 !== sha256 || published.buildSha256 !== buildSha256) {
      throw new Error(`Commit ${sourceSha} was already published with different package contents.`);
    }
  }

  await mkdir(join(appRoot, "public"), { recursive: true });
  await writeFile(
    join(appRoot, "public/index.html"),
    `<!doctype html><title>eve packages</title><pre>${JSON.stringify(manifest, null, 2)}</pre>\n`,
  );
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
} finally {
  await writeFile(evePackageJsonPath, originalEvePackageJson);
  await writeFile(buildPackageJsonPath, originalBuildPackageJson);
  await rm(artifactDirectory, { force: true, recursive: true });
}
