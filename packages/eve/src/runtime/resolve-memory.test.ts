import { describe, expect, it } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID, type CompiledMemoryDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import { byPrincipal, defineMemory, defineMemoryProvider } from "#public/memory/index.js";
import { resolveMemoryDefinition } from "#runtime/resolve-memory.js";

const definition: CompiledMemoryDefinition = {
  logicalPath: "memory/user.ts",
  slot: "user",
  sourceId: "memory/user.ts",
  sourceKind: "module",
};

describe("resolveMemoryDefinition", () => {
  it("resolves the three-method provider and defaults visibility to scope", async () => {
    const provider = defineMemoryProvider({
      recall: () => ({ content: "remembered" }),
      save: async () => {},
      tools: () => null,
    });

    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap(defineMemory({ provider, scope: byPrincipal() })),
        undefined,
      ),
    ).resolves.toMatchObject({
      provider,
      slot: "user",
      visibility: "scope",
    });
  });

  it("preserves explicit session visibility", async () => {
    const provider = defineMemoryProvider({ recall: () => undefined });

    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap(defineMemory({ provider, scope: byPrincipal(), visibility: "session" })),
        undefined,
      ),
    ).resolves.toMatchObject({ visibility: "session" });
  });

  it("requires provider.recall", async () => {
    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap({ provider: {}, scope: byPrincipal() }),
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
          buildModuleMap({ provider, scope: byPrincipal() }),
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
          scope: byPrincipal(),
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
          scope: byPrincipal(),
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
