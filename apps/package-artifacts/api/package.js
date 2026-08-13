import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { get } from "@vercel/blob";

import {
  PULL_REQUEST_PATTERN,
  SHA_PATTERN,
  packageArtifactPath,
  packageManifestPath,
  unverifiedPackageArtifactPath,
  unverifiedPackageManifestPath,
  unverifiedPullRequestManifestPath,
} from "../lib/package.mjs";

export default async function handler(request, response) {
  const scope = request.query.scope === "unverified" ? "unverified" : "trusted";
  const ref = request.query.ref;
  const pullRequest = request.query.pr;

  if (scope === "unverified" && typeof pullRequest === "string") {
    return servePullRequest(pullRequest, request, response);
  }
  if (
    typeof ref !== "string" ||
    (scope === "trusted" && ref !== "main" && !SHA_PATTERN.test(ref))
  ) {
    return packageNotFound(response);
  }
  if (scope === "unverified" && !SHA_PATTERN.test(ref)) return packageNotFound(response);

  const sourceSha = ref === "main" ? process.env.VERCEL_GIT_COMMIT_SHA : ref;
  if (!SHA_PATTERN.test(sourceSha ?? "")) return packageNotFound(response);

  const manifest = await resolveManifest(sourceSha, scope);
  if (manifest === undefined) return packageNotFound(response);

  if (request.query.manifest === "1") {
    if (ref !== "main") return packageNotFound(response);
    response.setHeader("Cache-Control", "public, max-age=60");
    return response.status(200).json(manifest);
  }
  if (ref === "main") {
    response.setHeader("Cache-Control", "public, max-age=60");
    return response.redirect(302, manifest.tarball);
  }

  return streamArtifact(sourceSha, scope, response);
}

async function servePullRequest(pullRequest, request, response) {
  if (!PULL_REQUEST_PATTERN.test(pullRequest)) return packageNotFound(response);
  const pointer = await get(unverifiedPullRequestManifestPath(pullRequest), { access: "private" });
  if (pointer === null) return packageNotFound(response);

  const manifest = parseManifest(await new Response(pointer.stream).text(), "unverified");
  if (manifest === undefined || manifest.pullRequest !== Number(pullRequest)) {
    return packageNotFound(response);
  }
  if (request.query.manifest === "1") {
    response.setHeader("Cache-Control", "public, max-age=60");
    return response.status(200).json(manifest);
  }
  response.setHeader("Cache-Control", "public, max-age=60");
  return response.redirect(302, manifest.tarball);
}

async function streamArtifact(sourceSha, scope, response) {
  const path =
    scope === "unverified"
      ? unverifiedPackageArtifactPath(sourceSha)
      : packageArtifactPath(sourceSha);
  const artifact = await get(path, { access: "private" });
  if (artifact === null) return packageNotFound(response);

  response.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  response.setHeader("Content-Type", "application/gzip");
  await pipeline(Readable.fromWeb(artifact.stream), response);
  return undefined;
}

function packageNotFound(response) {
  return response.status(404).send("Package not found.\n");
}

async function resolveManifest(sourceSha, scope) {
  const path =
    scope === "unverified"
      ? unverifiedPackageManifestPath(sourceSha)
      : packageManifestPath(sourceSha);
  const result = await get(path, { access: "private" });
  if (result === null) return undefined;
  return parseManifest(await new Response(result.stream).text(), scope);
}

function parseManifest(source, scope) {
  const manifest = JSON.parse(source);
  if (
    !SHA_PATTERN.test(manifest.sourceSha ?? "") ||
    typeof manifest.version !== "string" ||
    typeof manifest.tarball !== "string" ||
    typeof manifest.sha256 !== "string" ||
    manifest.trust !== scope
  ) {
    return undefined;
  }
  return manifest;
}
