import type { MemoryDocumentBackend } from "#public/memory/file/backend.js";
import { inMemory } from "#public/memory/file/backends/in-memory.js";
import { lazyBackend } from "#public/memory/file/backends/lazy.js";
import { vercelBlob } from "#public/memory/file/backends/vercel-blob.js";

/** Environment probe behind the default backend selection. */
interface DefaultFileMemoryBackendProbes {
  readonly isDeployedOnVercel: () => boolean;
  readonly isProduction: () => boolean;
}

const PRODUCTION_PROBES: DefaultFileMemoryBackendProbes = {
  isDeployedOnVercel: () => Boolean(process.env.VERCEL),
  isProduction: () => process.env.NODE_ENV === "production",
};

/**
 * Selects private Vercel Blob storage on Vercel and process-local storage for
 * development. Other production environments must configure a backend.
 * Selection is deferred and cached for the process lifetime.
 */
export function defaultFileMemoryBackend(): MemoryDocumentBackend {
  return lazyBackend(() => selectDefaultFileMemoryBackend(PRODUCTION_PROBES));
}

/** @internal Selection primitive with injectable environment probes for tests. */
function selectDefaultFileMemoryBackend(
  probes: DefaultFileMemoryBackendProbes,
): MemoryDocumentBackend {
  if (probes.isDeployedOnVercel()) return vercelBlob();
  if (probes.isProduction()) {
    throw new Error(
      "fileMemory() requires an explicit backend outside Vercel in production. Pass fileMemory({ backend }).",
    );
  }
  return inMemory();
}
