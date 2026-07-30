import {
  createDockerSandboxEngine,
  createJustBashSandboxEngine,
  createMicrosandboxSandboxEngine,
  isDockerDaemonAvailableSync,
  isMicrosandboxPlatformSupported,
} from "#execution/sandbox/bindings/local.js";
import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";
import { lazyEngine } from "#execution/sandbox/lazy-engine.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";
import type { SandboxEngine } from "#shared/sandbox-engine.js";

/**
 * Per-provider options used when `DefaultSandbox` selects an available
 * implementation.
 */
export interface DefaultSandboxOptions {
  readonly docker?: DockerSandboxCreateOptions;
  readonly justBash?: JustBashSandboxCreateOptions;
  readonly microsandbox?: MicrosandboxSandboxCreateOptions;
  readonly vercel?: VercelSandboxCreateOptions;
}

export interface DefaultSandboxProbes {
  readonly isDeployedOnVercel: () => boolean;
  readonly isDockerAvailable: () => boolean;
  readonly isMicrosandboxSupported: () => boolean;
}

const PRODUCTION_PROBES: DefaultSandboxProbes = {
  isDeployedOnVercel: () => Boolean(process.env.VERCEL),
  isDockerAvailable: () => isDockerDaemonAvailableSync(),
  isMicrosandboxSupported: () => isMicrosandboxPlatformSupported(),
};

export function createDefaultSandboxEngine(options?: DefaultSandboxOptions): SandboxEngine {
  return lazyEngine(() => selectDefaultSandboxEngine(options, PRODUCTION_PROBES));
}

export function selectDefaultSandboxEngine(
  options: DefaultSandboxOptions | undefined,
  probes: DefaultSandboxProbes,
): SandboxEngine {
  if (probes.isDeployedOnVercel()) {
    return createVercelSandbox({ createOptions: options?.vercel });
  }
  if (probes.isDockerAvailable()) {
    return createDockerSandboxEngine({ createOptions: options?.docker });
  }
  if (probes.isMicrosandboxSupported()) {
    return createMicrosandboxSandboxEngine({
      createOptions: options?.microsandbox,
    });
  }
  return createJustBashSandboxEngine({ createOptions: options?.justBash });
}
