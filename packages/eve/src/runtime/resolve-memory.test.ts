import { describe, expect, it } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID, type CompiledMemoryDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { defaultNamespace, defineMemory, defineMemoryProvider } from "#public/memory/index.js";
import { byPrincipal } from "#public/memory/scope.js";
import { resolveMemoryDefinition } from "#runtime/resolve-memory.js";

const definition: CompiledMemoryDefinition = {
  logicalPath: "memory/user.ts",
  slot: "user",
  sourceId: "memory/user.ts",
  sourceKind: "module",
};

describe("resolveMemoryDefinition", () => {
  it("resolves the description and three-method provider and defaults visibility to scope", async () => {
    const provider = defineMemoryProvider({
      recall: () => ({ content: "remembered", role: "user" }),
      save: async () => {},
      tools: () => null,
    });

    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap(
          defineMemory({ description: "Personal memory.", provider, scope: byPrincipal }),
        ),
        undefined,
      ),
    ).resolves.toMatchObject({
      description: "Personal memory.",
      namespace: defaultNamespace,
      provider,
      slot: "user",
      visibility: "scope",
    });
  });

  it.each(["", "   ", 42])("rejects an invalid description", async (description) => {
    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap({
          description,
          provider: { recall: () => undefined },
          scope: "user-1",
        }),
        undefined,
      ),
    ).rejects.toThrow(/description.*non-whitespace string/u);
  });

  it("preserves explicit scalar, promise, and resolver addressing", async () => {
    const provider = defineMemoryProvider({ recall: () => undefined });
    const namespace = Promise.resolve("app");
    const scope = Promise.resolve("user-1");

    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap(defineMemory({ namespace, provider, scope })),
        undefined,
      ),
    ).resolves.toMatchObject({ namespace, scope });

    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap(defineMemory({ namespace: null, provider, scope: null })),
        undefined,
      ),
    ).resolves.toMatchObject({ namespace: null, scope: null });
  });

  it.each([
    { field: "scope", memory: { namespace: "app" } },
    { field: "namespace", memory: { namespace: "", scope: "user-1" } },
    { field: "scope", memory: { namespace: "app", scope: "" } },
    { field: "namespace", memory: { namespace: ["app"], scope: "user-1" } },
    { field: "scope", memory: { namespace: "app", scope: ["user-1"] } },
  ])("rejects an unsupported $field definition", async ({ field, memory }) => {
    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap({ provider: { recall: () => undefined }, ...memory }),
        undefined,
      ),
    ).rejects.toThrow(new RegExp(field, "u"));
  });

  it("preserves explicit session visibility", async () => {
    const provider = defineMemoryProvider({ recall: () => undefined });

    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap(defineMemory({ provider, scope: byPrincipal, visibility: "session" })),
        undefined,
      ),
    ).resolves.toMatchObject({ visibility: "session" });
  });

  it("requires provider.recall", async () => {
    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap({ provider: {}, scope: byPrincipal }),
        undefined,
      ),
    ).rejects.toThrow(/provider\.recall/u);
  });

  it.each(["recall", "save", "tools"] as const)(
    "rejects a non-function provider.%s",
    async (method) => {
      const provider: Record<string, unknown> = { recall: () => undefined };
      provider[method] = "invalid";

      await expect(
        resolveMemoryDefinition(
          definition,
          buildModuleMap({ provider, scope: byPrincipal }),
          undefined,
        ),
      ).rejects.toThrow(new RegExp(`provider\\.${method}`, "u"));
    },
  );

  it("rejects removed event maps", async () => {
    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap({
          provider: { events: {}, recall: () => undefined },
          scope: byPrincipal,
        }),
        undefined,
      ),
    ).rejects.toThrow(/Unknown key "events"/u);
  });

  it("rejects unsupported visibility", async () => {
    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap({
          provider: { recall: () => undefined },
          scope: byPrincipal,
          visibility: "provider",
        }),
        undefined,
      ),
    ).rejects.toThrow(/visibility.*scope.*session/u);
  });
});

function buildModuleMap(memory: unknown): CompiledModuleMap {
  return {
    nodes: {
      [ROOT_COMPILED_AGENT_NODE_ID]: {
        modules: { [definition.sourceId]: { default: memory } },
      },
    },
  };
}
