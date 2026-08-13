import { createHash } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { get, put } from "@vercel/blob";

import {
  PULL_REQUEST_PATTERN,
  SHA_PATTERN,
  packageArtifactPath,
  packageDependencyUrl,
  packageManifestPath,
  preparePackageJson,
  unverifiedPackageArtifactPath,
  unverifiedPackageManifestPath,
  unverifiedPullRequestManifestPath,
} from "../lib/package.mjs";
import { packPackage } from "../lib/pack.mjs";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(appRoot, "../..");
const packageRoot = join(repoRoot, "packages/eve");
const packageJsonPath = join(packageRoot, "package.json");
const artifactDirectory = join(appRoot, ".artifacts");
const sourceSha = process.env.VERCEL_GIT_COMMIT_SHA;
const branch = process.env.VERCEL_GIT_COMMIT_REF;
const productionDomain = process.env.VERCEL_PROJECT_PRODUCTION_URL;
const deploymentDomain = process.env.VERCEL_URL;
const pullRequest = process.env.EVE_PULL_REQUEST_NUMBER;
const isTrustedPublisher =
  branch === "main" &&
  process.env.VERCEL_ENV === "production" &&
  process.env.EVE_PACKAGE_ARTIFACT_SCOPE !== "unverified";
// Configure this only in the separate Preview project connected to the unverified Blob store.
const isUnverifiedPublisher =
  process.env.VERCEL_ENV === "preview" && process.env.EVE_PACKAGE_ARTIFACT_SCOPE === "unverified";

if (!SHA_PATTERN.test(sourceSha ?? "")) {
  throw new Error("VERCEL_GIT_COMMIT_SHA must be a 40-character Git commit SHA.");
}
if (pullRequest !== undefined && !PULL_REQUEST_PATTERN.test(pullRequest)) {
  throw new Error("EVE_PULL_REQUEST_NUMBER must be a positive integer.");
}

if (!isTrustedPublisher && !isUnverifiedPublisher) {
  await writeLandingPage();
  process.exit(0);
}

const scope = isTrustedPublisher ? "trusted" : "unverified";
const packageDomain = isTrustedPublisher ? productionDomain : deploymentDomain;
if (typeof packageDomain !== "string" || packageDomain.length === 0) {
  throw new Error(
    isTrustedPublisher
      ? "VERCEL_PROJECT_PRODUCTION_URL is required for trusted package publishing."
      : "VERCEL_URL is required for unverified package publishing.",
  );
}

const originalPackageJson = await readFile(packageJsonPath, "utf8");
const preparedPackageJson = preparePackageJson(JSON.parse(originalPackageJson), sourceSha, scope);
const version = preparedPackageJson.version;
const baseUrl = `https://${packageDomain}`;
const dependencyUrl = packageDependencyUrl(baseUrl, sourceSha, scope);
const artifactPath = isTrustedPublisher
  ? packageArtifactPath(sourceSha)
  : unverifiedPackageArtifactPath(sourceSha);
const manifestPath = isTrustedPublisher
  ? packageManifestPath(sourceSha)
  : unverifiedPackageManifestPath(sourceSha);

try {
  await rm(artifactDirectory, { force: true, recursive: true });
  await writeFile(packageJsonPath, `${JSON.stringify(preparedPackageJson, null, 2)}\n`);
  const tarball = await packPackage(packageRoot, version, {
    ...process.env,
    EVE_PACKAGE_DEPENDENCY_URL: dependencyUrl,
  });
  const sha256 = createHash("sha256").update(tarball).digest("hex");
  const manifest = { sourceSha, version, tarball: dependencyUrl, sha256, trust: scope };

  await putImmutableArtifact(artifactPath, tarball, sha256);
  await putImmutableManifest(manifestPath, manifest);

  if (isUnverifiedPublisher && typeof pullRequest === "string") {
    const pullRequestManifest = { ...manifest, pullRequest: Number(pullRequest) };
    await put(unverifiedPullRequestManifestPath(pullRequest), JSON.stringify(pullRequestManifest), {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: true,
      cacheControlMaxAge: 60,
      contentType: "application/json",
    });
  }

  await writeLandingPage();
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
} finally {
  await writeFile(packageJsonPath, originalPackageJson);
  await rm(artifactDirectory, { force: true, recursive: true });
}

async function putImmutableArtifact(pathname, tarball, sha256) {
  try {
    await put(pathname, tarball, immutablePutOptions("application/gzip"));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    const published = await get(pathname, { access: "private", useCache: false });
    if (published === null) throw new Error("Published package artifact could not be read.");
    const publishedSha256 = createHash("sha256")
      .update(Buffer.from(await new Response(published.stream).arrayBuffer()))
      .digest("hex");
    if (publishedSha256 !== sha256) {
      throw new Error(`Commit ${sourceSha} was already published with different package contents.`);
    }
  }
}

async function putImmutableManifest(pathname, manifest) {
  try {
    await put(pathname, JSON.stringify(manifest), immutablePutOptions("application/json"));
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    const published = await get(pathname, { access: "private", useCache: false });
    if (published === null) throw new Error("Published package manifest could not be read.");
    const existing = JSON.parse(await new Response(published.stream).text());
    if (existing.sha256 !== manifest.sha256) {
      throw new Error(`Commit ${sourceSha} was already published with different package contents.`);
    }
  }
}

function immutablePutOptions(contentType) {
  return {
    access: "private",
    addRandomSuffix: false,
    allowOverwrite: false,
    cacheControlMaxAge: 31_536_000,
    contentType,
  };
}

async function writeLandingPage() {
  await mkdir(join(appRoot, "public"), { recursive: true });
  await writeFile(
    join(appRoot, "public", "index.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>eve packages</title>
    <style>
      :root { color-scheme: light dark; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fff; color: #111; font-family: Geist, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      main { width: min(100% - 48px, 480px); text-align: center; }
      .mark { width: 32px; height: 32px; margin: 0 auto 24px; border-radius: 50%; background: #111; }
      h1 { margin: 0; font-size: 20px; font-weight: 500; letter-spacing: -0.03em; }
      p { margin: 8px 0 0; color: #666; font-size: 14px; }
      @media (prefers-color-scheme: dark) { body { background: #000; color: #ededed; } .mark { background: #ededed; } p { color: #888; } }
    </style>
  </head>
  <body><main><div class="mark" aria-hidden="true"></div><h1>eve packages</h1><p>Package artifacts for eve development.</p></main></body>
</html>
`,
  );
}
