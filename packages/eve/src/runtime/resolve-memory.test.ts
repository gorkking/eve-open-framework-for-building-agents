import { describe, expect, it } from "vitest";

import { ROOT_COMPILED_AGENT_NODE_ID, type CompiledMemoryDefinition } from "#compiler/manifest.js";
import type { CompiledModuleMap } from "#compiler/module-map.js";
import {
  byPrincipal,
  defineDynamic,
  defineMemory,
  defineMemoryProvider,
} from "#public/memory/index.js";
import { resolveMemoryDefinition } from "#runtime/resolve-memory.js";

const definition: CompiledMemoryDefinition = {
  logicalPath: "memory/user.ts",
  slot: "user",
  sourceId: "memory/user.ts",
  sourceKind: "module",
};

describe("resolveMemoryDefinition", () => {
  it("resolves a structural memory slot and its dynamic tools", async () => {
    const provider = defineMemoryProvider({
      events: { "message.received": () => null },
      tools: defineDynamic({ events: { "step.started": () => null } }),
    });

    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap(defineMemory({ provider, scope: byPrincipal() })),
        undefined,
      ),
    ).resolves.toMatchObject({
      dynamicToolResolver: {
        eventNames: ["step.started"],
        extensionNamespace: "user",
        onError: "throw",
      },
      provider,
      slot: "user",
    });
  });

  it("rejects unsupported provider lifecycle keys", async () => {
    const provider = defineMemoryProvider({ events: {} });
    Object.assign(provider.events!, { "step.started": () => undefined });

    await expect(
      resolveMemoryDefinition(
        definition,
        buildModuleMap(defineMemory({ provider, scope: byPrincipal() })),
        undefined,
      ),
    ).rejects.toThrow(/supported event key.*step\.started/);
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
