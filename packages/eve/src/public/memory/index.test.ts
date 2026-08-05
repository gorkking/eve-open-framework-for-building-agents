import { describe, expect, it } from "vitest";

import type { MemoryScopeContext } from "#public/memory/index.js";
import {
  byPrincipal,
  defineDynamic,
  defineMemory,
  defineMemoryProvider,
} from "#public/memory/index.js";

function scopeContext(principalId?: string): MemoryScopeContext {
  return {
    session: {
      auth: {
        current:
          principalId === undefined
            ? null
            : {
                attributes: {},
                authenticator: "slack",
                principalId,
                principalType: "user",
              },
        initiator: null,
      },
      id: "session-1",
      turn: { id: "turn-1", sequence: 0 },
    },
    getSandbox: async () => {
      throw new Error("not available");
    },
    getSkill: () => {
      throw new Error("not available");
    },
  };
}

describe("memory authoring", () => {
  it("defines providers and slots without rewriting them", () => {
    const events = {};
    const provider = defineMemoryProvider({ events });
    const definition = defineMemory({ provider, scope: byPrincipal() });

    expect(provider.events).toBe(events);
    expect(definition.provider).toBe(provider);
  });

  it("uses the standard dynamic sentinel for provider tools", () => {
    const tools = defineDynamic({
      events: {
        "step.started": () => null,
      },
    });

    expect(tools).toMatchObject({
      kind: "eve:dynamic",
      events: { "step.started": expect.any(Function) },
    });
  });

  it("derives a trusted principal tuple and disables unauthenticated turns", () => {
    const scope = byPrincipal();

    expect(scope(scopeContext("U123"))).toEqual(["user", "slack", "U123"]);
    expect(scope(scopeContext())).toBeNull();
  });
});
