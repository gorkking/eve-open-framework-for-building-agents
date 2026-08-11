import { afterEach, describe, expect, it, vi } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { defineDynamic } from "#public/definitions/tool.js";
import {
  loadDynamicRuntimeModelDefinition,
  normalizeDynamicRuntimeModelResult,
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

    const resolved = normalizeDynamicRuntimeModelResult({
      defaults: { contextWindowTokens: 256_000, id: "dynamic" },
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

  it("inherits agent-level model metadata", () => {
    const resolved = normalizeDynamicRuntimeModelResult({
      defaults: {
        contextWindowTokens: 256_000,
        id: "dynamic",
        providerOptions: { gateway: { order: ["openai"] } },
      },
      result: "openai/gpt-5.5-mini",
    });

    expect(resolved.reference).toEqual({
      contextWindowTokens: 256_000,
      id: "openai/gpt-5.5-mini",
      providerOptions: { gateway: { order: ["openai"] } },
    });
  });

  it("rejects selections with unknown keys", () => {
    expect(() =>
      normalizeDynamicRuntimeModelResult({
        defaults: { id: "dynamic" },
        result: {
          model: "openai/gpt-5.5-mini",
          contextWindowTokens: 128_000,
        } as never,
      }),
    ).toThrowError(/unknown key\(s\): contextWindowTokens/);
  });
});

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
