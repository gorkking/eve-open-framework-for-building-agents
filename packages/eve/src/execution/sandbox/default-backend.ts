import {
  createDockerSandboxBackend,
  createJustBashSandboxBackend,
  createMicrosandboxSandboxBackend,
  isDockerDaemonAvailableSync,
  isMicrosandboxPlatformSupported,
} from "#execution/sandbox/bindings/local.js";
import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";
import { lazyBackend } from "#execution/sandbox/lazy-backend.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";
import type { SandboxBackend } from "#shared/sandbox-backend.js";

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

export function createDefaultSandboxBackend(options?: DefaultSandboxOptions): SandboxBackend {
  return lazyBackend(() => selectDefaultSandboxBackend(options, PRODUCTION_PROBES));
}

export function selectDefaultSandboxBackend(
  options: DefaultSandboxOptions | undefined,
  probes: DefaultSandboxProbes,
): SandboxBackend {
  if (probes.isDeployedOnVercel()) {
    return createVercelSandbox({ createOptions: options?.vercel });
  }
  if (probes.isDockerAvailable()) {
    return createDockerSandboxBackend({ createOptions: options?.docker });
  }
  if (probes.isMicrosandboxSupported()) {
    return createMicrosandboxSandboxBackend({
      createOptions: options?.microsandbox,
    });
  }
  return createJustBashSandboxBackend({ createOptions: options?.justBash });
}
