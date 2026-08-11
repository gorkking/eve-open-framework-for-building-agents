import { describe, expect, it, vi } from "vitest";

import type { RuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import { ContextContainer } from "#context/container.js";
import {
  createStateCachedRuntimeModelCatalogLoader,
  DYNAMIC_MODEL_METADATA_CACHE_TTL_MS,
} from "#context/dynamic-model-metadata-cache.js";
import { DynamicModelMetadataCacheKey } from "#context/keys.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";

describe("state-cached dynamic model metadata", () => {
  it("reuses gateway metadata after a workflow state round trip", async () => {
    const source = createModelCatalog({
      getModelLimits: vi.fn(async () => ({ contextWindowTokens: 400_000 })),
    });
    const ctx = new ContextContainer();
    const loader = createStateCachedRuntimeModelCatalogLoader({ ctx, now: () => 1_000, source });

    await expect(loader.getModelLimits("openai/gpt-5.4")).resolves.toEqual({
      contextWindowTokens: 400_000,
    });

    const restoredCtx = await deserializeContext(serializeContext(ctx));
    const restoredSource = createModelCatalog();
    const restoredLoader = createStateCachedRuntimeModelCatalogLoader({
      ctx: restoredCtx,
      now: () => 2_000,
      source: restoredSource,
    });
    await expect(restoredLoader.getModelLimits("openai/gpt-5.4")).resolves.toEqual({
      contextWindowTokens: 400_000,
    });

    expect(source.getModelLimits).toHaveBeenCalledOnce();
    expect(restoredSource.getModelLimits).not.toHaveBeenCalled();
    expect(Object.keys(restoredCtx.require(DynamicModelMetadataCacheKey))).toHaveLength(1);
  });

  it("caches canonical metadata for live provider models", async () => {
    const source = createModelCatalog({
      getByProviderModelId: vi.fn(async () => ({
        limits: { contextWindowTokens: 200_000, maxOutputTokens: 32_000 },
        slug: "anthropic/claude-opus-4.7",
      })),
    });
    const ctx = new ContextContainer();
    const loader = createStateCachedRuntimeModelCatalogLoader({ ctx, now: () => 1_000, source });

    const first = await loader.getByProviderModelId("anthropic.messages", "claude-opus-4-7");
    const second = await loader.getByProviderModelId("anthropic.messages", "claude-opus-4-7");

    expect(first).toEqual(second);
    expect(second).toEqual({
      limits: { contextWindowTokens: 200_000, maxOutputTokens: 32_000 },
      slug: "anthropic/claude-opus-4.7",
    });
    expect(source.getByProviderModelId).toHaveBeenCalledOnce();
  });

  it("refreshes expired metadata", async () => {
    let now = 1_000;
    const getModelLimits = vi
      .fn<RuntimeModelCatalogLoader["getModelLimits"]>()
      .mockResolvedValueOnce({ contextWindowTokens: 100_000 })
      .mockResolvedValueOnce({ contextWindowTokens: 200_000 });
    const loader = createStateCachedRuntimeModelCatalogLoader({
      ctx: new ContextContainer(),
      now: () => now,
      source: createModelCatalog({ getModelLimits }),
    });

    await expect(loader.getModelLimits("example/model")).resolves.toEqual({
      contextWindowTokens: 100_000,
    });
    now += DYNAMIC_MODEL_METADATA_CACHE_TTL_MS + 1;
    await expect(loader.getModelLimits("example/model")).resolves.toEqual({
      contextWindowTokens: 200_000,
    });

    expect(getModelLimits).toHaveBeenCalledTimes(2);
  });

  it("prunes expired metadata when persisting a fresh entry", async () => {
    let now = 1_000;
    const ctx = new ContextContainer();
    const loader = createStateCachedRuntimeModelCatalogLoader({
      ctx,
      now: () => now,
      source: createModelCatalog({
        getModelLimits: vi.fn(async () => ({ contextWindowTokens: 100_000 })),
      }),
    });

    await loader.getModelLimits("example/old");
    now += DYNAMIC_MODEL_METADATA_CACHE_TTL_MS + 1;
    await loader.getModelLimits("example/fresh");

    const cache = ctx.require(DynamicModelMetadataCacheKey);
    expect(cache).not.toHaveProperty(JSON.stringify(["gateway", "example/old"]));
    expect(cache).toHaveProperty(JSON.stringify(["gateway", "example/fresh"]));
  });

  it("does not persist unresolved metadata", async () => {
    const source = createModelCatalog();
    const ctx = new ContextContainer();
    const loader = createStateCachedRuntimeModelCatalogLoader({ ctx, source });

    await expect(loader.getModelLimits("unknown/model")).resolves.toBeNull();
    await expect(loader.getModelLimits("unknown/model")).resolves.toBeNull();

    expect(source.getModelLimits).toHaveBeenCalledTimes(2);
    expect(ctx.get(DynamicModelMetadataCacheKey)).toBeUndefined();
  });
});

function createModelCatalog(
  overrides: Partial<RuntimeModelCatalogLoader> = {},
): RuntimeModelCatalogLoader {
  return {
    getByProviderModelId: vi.fn(async () => null),
    getModelLimits: vi.fn(async () => null),
    ...overrides,
  };
}
