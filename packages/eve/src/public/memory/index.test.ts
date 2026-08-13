import { z } from "#compiled/zod/index.js";
import { describe, expect, it } from "vitest";

import { defineTool } from "#public/definitions/tool.js";
import type { MemoryScopeContext } from "#public/memory/index.js";
import {
  byPrincipal,
  defineDynamic,
  defineMemory,
  defineMemoryProvider,
} from "#public/memory/index.js";

function scopeContext(principalId?: string, issuer?: string): MemoryScopeContext {
  return {
    abortSignal: new AbortController().signal,
    session: {
      auth: {
        current:
          principalId === undefined
            ? null
            : {
                attributes: {},
                authenticator: "slack",
                issuer,
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
  it("accepts structured single and array event results", () => {
    defineMemoryProvider({
      events: {
        "session.started": () => ({ content: "session memory" }),
        "turn.started": () => [{ content: "first" }, { content: "second" }],
      },
    });
  });

  it("rejects bare string event results", () => {
    defineMemoryProvider({
      events: {
        // @ts-expect-error Memory messages use the structured result contract.
        "turn.started": () => "memory",
      },
    });
  });

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
        "step.started": () => ({
          save: defineTool({
            description: "Save memory",
            execute: ({ text }) => ({ stored: text }),
            inputSchema: z.object({ text: z.string() }),
            toModelOutput: ({ stored }) => ({ type: "text", value: stored }),
          }),
        }),
      },
    });
    const provider = defineMemoryProvider({ tools });

    expect(tools).toMatchObject({
      kind: "eve:dynamic",
      events: { "step.started": expect.any(Function) },
      onError: "throw",
    });
    expect(provider.tools).toBe(tools);
  });

  it("allows scope to resolve asynchronously", async () => {
    const definition = defineMemory({
      provider: defineMemoryProvider({}),
      scope: async (context) => [await Promise.resolve(context.session.id)],
    });

    await expect(definition.scope(scopeContext())).resolves.toEqual(["session-1"]);
  });

  it("derives a trusted principal tuple and disables unauthenticated turns", () => {
    const scope = byPrincipal();

    expect(scope(scopeContext("U123"))).toEqual(["user", "slack", "U123"]);
    expect(scope(scopeContext("U123", "slack:T123"))).toEqual([
      "user",
      "slack",
      "slack:T123",
      "U123",
    ]);
    expect(scope(scopeContext())).toBeNull();
  });
});
