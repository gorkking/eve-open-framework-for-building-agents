import type { LanguageModel } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { RuntimeModelCatalogLoader } from "#compiler/model-catalog.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { defineDynamic } from "#public/definitions/tool.js";
import {
  loadDynamicRuntimeModelDefinition,
  resolveDynamicRuntimeModelResult,
  resolveRuntimeModelReference,
} from "#runtime/agent/resolve-model.js";

const DYNAMIC_MODEL_SOURCE = {
  eventNames: ["session.started"],
  logicalPath: "agent.ts",
  sourceId: "agent-config",
  sourceKind: "module" as const,
};

describe("dynamic runtime model resolution", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("does not resolve a source-free eve mock model without the test seam", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const model = await resolveRuntimeModelReference({ id: "eve-mock/dynamic-subagent" });

    expect(model).toBe("eve-mock/dynamic-subagent");
  });

  it("resolves a source-free eve mock model through the explicit test seam", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_MOCK_AUTHORED_MODELS", "1");

    const model = await resolveRuntimeModelReference({ id: "eve-mock/dynamic-subagent" });

    expect(typeof model).toBe("object");
    if (typeof model === "string") throw new Error("expected a mock model instance");
    expect(model.provider).toBe("eve-runtime-mock");
    expect(model.modelId).toBe("eve-mock/dynamic-subagent");
  });

  it("loads dynamic model definitions and normalizes string selections", async () => {
    const moduleMap = createModuleMap({
      default: {
        model: defineDynamic({
          events: {
            "session.started": (_event, ctx) => ({
              model: ctx.channel.kind === "slack" ? "openai/gpt-5.5-mini" : "openai/gpt-5.5",
              modelContextWindowTokens: 128_000,
              modelOptions: {
                providerOptions: { gateway: { order: ["openai"] } },
              },
            }),
          },
        }),
      },
    });

    const definition = await loadDynamicRuntimeModelDefinition({
      dynamicModel: DYNAMIC_MODEL_SOURCE,
      scope: { moduleMap, nodeId: undefined },
    });
    const result = await definition.events["session.started"]?.(
      { type: "session.started" },
      {
        channel: { kind: "slack" },
        messages: [{ content: "Hi", role: "user" }],
        session: { auth: { current: null, initiator: null }, id: "session-1" },
      },
    );

    expect(result).not.toBeNull();
    if (result === null || result === undefined) throw new Error("expected selection");

    const resolved = await resolveDynamicRuntimeModelResult({
      result,
    });

    expect(resolved).toEqual({
      reference: {
        contextWindowTokens: 128_000,
        id: "openai/gpt-5.5-mini",
        providerOptions: { gateway: { order: ["openai"] } },
      },
    });
  });

  it("inherits agent-level model metadata without consulting the catalog", async () => {
    const modelCatalog = createModelCatalog();
    const resolved = await resolveDynamicRuntimeModelResult({
      contextWindowTokens: 256_000,
      modelCatalog,
      providerOptions: { gateway: { order: ["openai"] } },
      result: "openai/gpt-5.5-mini",
    });

    expect(resolved.reference).toEqual({
      contextWindowTokens: 256_000,
      id: "openai/gpt-5.5-mini",
      providerOptions: { gateway: { order: ["openai"] } },
    });
    expect(modelCatalog.getModelLimits).not.toHaveBeenCalled();
  });

  it("resolves omitted context-window metadata from the catalog", async () => {
    const modelCatalog = createModelCatalog({
      getModelLimits: vi.fn(async () => ({ contextWindowTokens: 400_000 })),
    });

    const resolved = await resolveDynamicRuntimeModelResult({
      modelCatalog,
      result: "openai/gpt-5.4",
    });

    expect(resolved.reference).toEqual({
      contextWindowTokens: 400_000,
      id: "openai/gpt-5.4",
      providerOptions: undefined,
    });
    expect(modelCatalog.getModelLimits).toHaveBeenCalledWith("openai/gpt-5.4");
  });

  it("resolves live provider metadata by provider model id", async () => {
    const modelCatalog = createModelCatalog({
      getByProviderModelId: vi.fn(async () => ({
        limits: { contextWindowTokens: 200_000 },
        slug: "anthropic/claude-opus-4.7",
      })),
    });
    const model = createLanguageModel("anthropic.messages", "claude-opus-4-7");

    const resolved = await resolveDynamicRuntimeModelResult({ modelCatalog, result: model });

    expect(resolved).toEqual({
      model,
      reference: {
        contextWindowTokens: 200_000,
        id: "anthropic/claude-opus-4.7",
        providerOptions: undefined,
      },
    });
    expect(modelCatalog.getByProviderModelId).toHaveBeenCalledWith(
      "anthropic.messages",
      "claude-opus-4-7",
    );
  });

  it("requires explicit context-window metadata for unknown models", async () => {
    await expect(
      resolveDynamicRuntimeModelResult({
        modelCatalog: createModelCatalog(),
        result: "unknown/model",
      }),
    ).rejects.toThrow(
      'Dynamically selected model "unknown/model" does not have known AI Gateway context window metadata',
    );
  });

  it("rejects selections with unknown keys", async () => {
    await expect(
      resolveDynamicRuntimeModelResult({
        result: {
          model: "openai/gpt-5.5-mini",
          contextWindowTokens: 128_000,
        } as never,
      }),
    ).rejects.toThrowError(/unknown key\(s\): contextWindowTokens/);
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

function createModuleMap(moduleNamespace: Record<string, unknown>): CompiledModuleMap {
  return {
    nodes: {
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        modules: {
          [DYNAMIC_MODEL_SOURCE.sourceId]: moduleNamespace,
        },
      },
    },
  };
}

function createLanguageModel(provider: string, modelId: string): LanguageModel {
  return {
    specificationVersion: "v2",
    provider,
    modelId,
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error("not implemented");
    },
    doStream: async () => {
      throw new Error("not implemented");
    },
  };
}
