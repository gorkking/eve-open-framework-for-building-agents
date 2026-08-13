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
  previewPackageDependencyUrl,
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
const previewDomain = process.env.VERCEL_URL;
const isTrustedPublisher = branch === "main" && process.env.VERCEL_ENV === "production";
const isPreviewPackage = process.env.VERCEL_ENV === "preview";

if (!SHA_PATTERN.test(sourceSha ?? "")) {
  throw new Error("VERCEL_GIT_COMMIT_SHA must be a 40-character Git commit SHA.");
}
if (!isTrustedPublisher && !isPreviewPackage) {
  await writeLandingPage();
  process.exit(0);
}

const packageDomain = isTrustedPublisher ? productionDomain : previewDomain;
if (typeof packageDomain !== "string" || packageDomain.length === 0) {
  throw new Error(
    isTrustedPublisher
      ? "VERCEL_PROJECT_PRODUCTION_URL is required for trusted package publishing."
      : "VERCEL_URL is required for preview package publishing.",
  );
}

const channel = isTrustedPublisher ? "main" : "preview";
const originalPackageJson = await readFile(packageJsonPath, "utf8");
const preparedPackageJson = preparePackageJson(JSON.parse(originalPackageJson), sourceSha, channel);
const version = preparedPackageJson.version;
const dependencyUrl = isTrustedPublisher
  ? packageDependencyUrl(`https://${packageDomain}`, sourceSha)
  : previewPackageDependencyUrl(`https://${packageDomain}`);

try {
  await rm(artifactDirectory, { force: true, recursive: true });
  await writeFile(packageJsonPath, `${JSON.stringify(preparedPackageJson, null, 2)}\n`);
  const tarball = await packPackage(packageRoot, version, {
    ...process.env,
    EVE_PACKAGE_DEPENDENCY_URL: dependencyUrl,
  });

  if (isPreviewPackage) {
    await mkdir(join(appRoot, "public"), { recursive: true });
    await writeFile(join(appRoot, "public", "eve.tgz"), tarball);
    await writeLandingPage();
    process.stdout.write(`${JSON.stringify({ sourceSha, version, tarball: dependencyUrl })}\n`);
    process.exit(0);
  }

  const sha256 = createHash("sha256").update(tarball).digest("hex");
  const artifactPath = packageArtifactPath(sourceSha);
  try {
    await put(artifactPath, tarball, {
      access: "private",
      addRandomSuffix: false,
      allowOverwrite: false,
      cacheControlMaxAge: 31_536_000,
      contentType: "application/gzip",
    });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("already exists")) throw error;
    const publishedArtifact = await get(artifactPath, { access: "private", useCache: false });
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

  const manifest = { sourceSha, version, tarball: dependencyUrl, sha256 };
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
    if (published.sha256 !== sha256) {
      throw new Error(`Commit ${sourceSha} was already published with different package contents.`);
    }
  }

  await writeLandingPage();
  process.stdout.write(`${JSON.stringify(manifest)}\n`);
} finally {
  await writeFile(packageJsonPath, originalPackageJson);
  await rm(artifactDirectory, { force: true, recursive: true });
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
