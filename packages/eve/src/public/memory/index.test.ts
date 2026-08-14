import { z } from "#compiled/zod/index.js";
import { describe, expect, it } from "vitest";

import { defineTool } from "#public/definitions/tool.js";
import type { MemoryScopeContext, MemoryToolSet } from "#public/memory/index.js";
import { byPrincipal, defineMemory, defineMemoryProvider } from "#public/memory/index.js";

function scopeContext(input: { readonly issuer?: string; readonly principalId?: string } = {}) {
  return {
    abortSignal: new AbortController().signal,
    session: {
      auth: {
        current:
          input.principalId === undefined
            ? null
            : {
                attributes: {},
                authenticator: "slack",
                issuer: input.issuer,
                principalId: input.principalId,
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
  } satisfies MemoryScopeContext;
}

describe("memory authoring", () => {
  it("defines the three-method provider contract without rewriting it", () => {
    const recall = () => ({ content: "remembered" });
    const save = async () => {};
    const tools = () => null;
    const provider = defineMemoryProvider({ recall, save, tools });
    const definition = defineMemory({
      provider,
      scope: byPrincipal(),
      visibility: "session",
    });

    expect(provider).toEqual({ recall, save, tools });
    expect(definition).toMatchObject({ provider, visibility: "session" });
  });

  it("requires recall and rejects the removed event-map contract", () => {
    // @ts-expect-error Memory providers must implement recall.
    defineMemoryProvider({});
    defineMemoryProvider({
      // @ts-expect-error Memory providers do not expose lifecycle event maps.
      events: {},
      recall: () => undefined,
    });
  });

  it("accepts inferred tool definitions in the heterogeneous provider tool set", () => {
    const remember = defineTool({
      approval: ({ toolInput }) =>
        toolInput?.text === "approved" ? "not-applicable" : "user-approval",
      description: "Remember text.",
      execute: ({ text }) => ({ stored: text }),
      inputSchema: z.object({ text: z.string() }),
      toModelOutput: ({ stored }) => ({ type: "text", value: stored }),
    });
    const tools = { remember } satisfies MemoryToolSet;
    const provider = defineMemoryProvider({ recall: () => undefined, tools: () => tools });

    expect(provider.tools()).toEqual(tools);
    expect(remember.execute({ text: "hello" }, {} as never)).toEqual({ stored: "hello" });
    expect(remember.toModelOutput?.({ stored: "hello" })).toEqual({
      type: "text",
      value: "hello",
    });
  });

  it("allows asynchronous scope resolution with cancellation", async () => {
    const context = scopeContext({ principalId: "U123" });
    const definition = defineMemory({
      provider: defineMemoryProvider({ recall: () => undefined }),
      scope: async (ctx) => {
        expect(ctx.abortSignal).toBe(context.abortSignal);
        return await Promise.resolve([ctx.session.id]);
      },
    });

    await expect(definition.scope(context)).resolves.toEqual(["session-1"]);
  });

  it("derives a trusted principal tuple including issuer when present", () => {
    const scope = byPrincipal();

    expect(scope(scopeContext({ principalId: "U123" }))).toEqual(["user", "slack", "U123"]);
    expect(
      scope(scopeContext({ issuer: "https://slack.com/team/T123", principalId: "U123" })),
    ).toEqual(["user", "slack", "https://slack.com/team/T123", "U123"]);
    expect(scope(scopeContext())).toBeNull();
  });
});
