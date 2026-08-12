import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import { inMemory, type InMemoryBackendOptions } from "#public/memory/file/backends/in-memory.js";
import { lazyBackend } from "#public/memory/file/backends/lazy.js";
import {
  vercelBlob,
  type VercelBlobBackendOptions,
} from "#public/memory/file/backends/vercel-blob.js";

/** Per-environment options for {@link defaultFileMemoryBackend}. */
export interface DefaultFileMemoryBackendOptions {
  readonly inMemory?: InMemoryBackendOptions;
  readonly vercelBlob?: VercelBlobBackendOptions;
}

/** Environment probe behind the default backend selection. */
export interface DefaultFileMemoryBackendProbes {
  readonly isDeployedOnVercel: () => boolean;
}

const PRODUCTION_PROBES: DefaultFileMemoryBackendProbes = {
  isDeployedOnVercel: () => Boolean(process.env.VERCEL),
};

/**
 * Selects private Vercel Blob storage on Vercel and process-local storage
 * elsewhere. Selection is deferred and cached for the process lifetime.
 */
export function defaultFileMemoryBackend(
  options?: DefaultFileMemoryBackendOptions,
): MemoryDocumentBackend {
  return lazyBackend(() => selectDefaultFileMemoryBackend(options, PRODUCTION_PROBES));
}

/** @internal Selection primitive with injectable environment probes for tests. */
export function selectDefaultFileMemoryBackend(
  options: DefaultFileMemoryBackendOptions | undefined,
  probes: DefaultFileMemoryBackendProbes,
): MemoryDocumentBackend {
  return probes.isDeployedOnVercel()
    ? vercelBlob(options?.vercelBlob)
    : inMemory(options?.inMemory);
}
