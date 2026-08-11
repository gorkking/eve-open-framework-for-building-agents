import {
  createRuntimeModelCatalogLoader,
  type CompiledRuntimeModelLimits,
  type RuntimeModelCatalogLoader,
} from "#compiler/model-catalog.js";
import type { AlsContext } from "#context/container.js";
import {
  DynamicModelMetadataCacheKey,
  type DurableDynamicModelMetadataCacheEntry,
} from "#context/keys.js";

export const DYNAMIC_MODEL_METADATA_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function createStateCachedRuntimeModelCatalogLoader(input: {
  readonly ctx: AlsContext;
  readonly now?: () => number;
  readonly source?: RuntimeModelCatalogLoader;
}): RuntimeModelCatalogLoader {
  const now = input.now ?? Date.now;
  const source = input.source ?? createRuntimeModelCatalogLoader();

  return {
    async getModelLimits(modelId) {
      const cacheKey = JSON.stringify(["gateway", modelId]);
      const cached = readCachedEntry(input.ctx, cacheKey, now());
      if (cached !== undefined) {
        return limitsFromEntry(cached);
      }

      const limits = await source.getModelLimits(modelId);
      if (limits === null) {
        return null;
      }

      const resolvedAt = now();
      writeCachedEntry(
        input.ctx,
        cacheKey,
        {
          ...limits,
          expiresAt: resolvedAt + DYNAMIC_MODEL_METADATA_CACHE_TTL_MS,
          resolvedModelId: modelId,
        },
        resolvedAt,
      );
      return limits;
    },

    async getByProviderModelId(provider, providerModelId) {
      const cacheKey = JSON.stringify(["provider", provider, providerModelId]);
      const cached = readCachedEntry(input.ctx, cacheKey, now());
      if (cached !== undefined) {
        return {
          limits: limitsFromEntry(cached),
          slug: cached.resolvedModelId,
        };
      }

      const resolved = await source.getByProviderModelId(provider, providerModelId);
      if (resolved === null) {
        return null;
      }

      const resolvedAt = now();
      writeCachedEntry(
        input.ctx,
        cacheKey,
        {
          ...resolved.limits,
          expiresAt: resolvedAt + DYNAMIC_MODEL_METADATA_CACHE_TTL_MS,
          resolvedModelId: resolved.slug,
        },
        resolvedAt,
      );
      return resolved;
    },
  };
}

function readCachedEntry(
  ctx: AlsContext,
  cacheKey: string,
  now: number,
): DurableDynamicModelMetadataCacheEntry | undefined {
  const entry = ctx.get(DynamicModelMetadataCacheKey)?.[cacheKey];
  return entry !== undefined && entry.expiresAt > now ? entry : undefined;
}

function writeCachedEntry(
  ctx: AlsContext,
  cacheKey: string,
  entry: DurableDynamicModelMetadataCacheEntry,
  now: number,
): void {
  ctx.set(DynamicModelMetadataCacheKey, (current) => {
    const freshEntries = Object.fromEntries(
      Object.entries(current ?? {}).filter(([, cached]) => cached.expiresAt > now),
    );
    return {
      ...freshEntries,
      [cacheKey]: entry,
    };
  });
}

function limitsFromEntry(entry: DurableDynamicModelMetadataCacheEntry): CompiledRuntimeModelLimits {
  const limits: CompiledRuntimeModelLimits = {
    contextWindowTokens: entry.contextWindowTokens,
  };
  if (entry.maxOutputTokens !== undefined) {
    limits.maxOutputTokens = entry.maxOutputTokens;
  }
  return limits;
}
