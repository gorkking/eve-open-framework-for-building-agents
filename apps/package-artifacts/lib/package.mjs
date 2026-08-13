export const SHA_PATTERN = /^[0-9a-f]{40}$/i;
export const PULL_REQUEST_PATTERN = /^[1-9]\d*$/;

export function packageArtifactPath(sourceSha) {
  return `packages/${sourceSha}/eve.tgz`;
}

export function packageManifestPath(sourceSha) {
  return `packages/${sourceSha}/manifest.json`;
}

export function unverifiedPackageArtifactPath(sourceSha) {
  return `unverified/sha/${sourceSha}/eve.tgz`;
}

export function unverifiedPackageManifestPath(sourceSha) {
  return `unverified/sha/${sourceSha}/manifest.json`;
}

export function unverifiedPullRequestManifestPath(pullRequest) {
  if (!PULL_REQUEST_PATTERN.test(pullRequest)) {
    throw new Error("Pull request number must be a positive integer.");
  }
  return `unverified/pr/${pullRequest}/latest.json`;
}

export function packageDependencyUrl(baseUrl, sourceSha, scope = "trusted") {
  const url = new URL(baseUrl);
  if (url.protocol !== "https:") throw new Error("Package base URL must use HTTPS.");
  url.pathname =
    scope === "unverified"
      ? `${url.pathname.replace(/\/$/, "")}/unverified/sha/${sourceSha}/eve.tgz`
      : `${url.pathname.replace(/\/$/, "")}/${sourceSha}/eve.tgz`;
  return url.toString();
}

export function packageVersion(stableVersion, sourceSha, scope = "trusted") {
  const match = stableVersion.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (match === null) throw new Error(`Expected a stable eve version, received ${stableVersion}.`);
  const channel = scope === "unverified" ? "unverified" : "main";
  return `${stableVersion}+${channel}.${sourceSha}`;
}

export function preparePackageJson(packageJson, sourceSha, scope) {
  return { ...packageJson, version: packageVersion(packageJson.version, sourceSha, scope) };
}
