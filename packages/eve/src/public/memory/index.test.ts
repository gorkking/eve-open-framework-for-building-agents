import { z } from "#compiled/zod/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { runWithDefaultMemoryNamespaceContext } from "#context/default-memory-namespace-context.js";
import { defineTool } from "#public/definitions/tool.js";
import type { MemoryToolSet } from "#public/memory/index.js";
import { defaultNamespace, defineMemory, defineMemoryProvider } from "#public/memory/index.js";

function createContext(): ContextContainer {
  return new ContextContainer();
}

describe("memory authoring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defines the three-method provider contract without rewriting it", () => {
    const recall = () => ({ content: "remembered" });
    const save = async () => {};
    const tools = () => null;
    const scope = () => "user-1";
    const provider = defineMemoryProvider({ recall, save, tools });
    const definition = defineMemory({
      namespace: "production",
      provider,
      scope,
      visibility: "session",
    });

    expect(provider).toEqual({ recall, save, tools });
    expect(definition).toEqual({
      namespace: "production",
      provider,
      scope,
      visibility: "session",
    });
  });

  it("accepts scalar, promise, and resolver addressing definitions", () => {
    const provider = defineMemoryProvider({ recall: () => undefined });

    expect(defineMemory({ provider, scope: "user-1" }).scope).toBe("user-1");
    expect(defineMemory({ namespace: null, provider, scope: "user-1" }).namespace).toBeNull();
    expect(defineMemory({ provider, scope: null }).scope).toBeNull();
    expect(defineMemory({ provider, scope: Promise.resolve("user-1") }).scope).toBeInstanceOf(
      Promise,
    );
    expect(
      defineMemory({
        namespace: async () => "app",
        provider,
        scope: async (ctx) => [ctx.session.id, "user-1"],
      }),
    ).toMatchObject({ provider });
    expect(
      defineMemory({ namespace: Promise.resolve(null), provider, scope: Promise.resolve(null) }),
    ).toMatchObject({ provider });

    defineMemory({
      provider,
      // @ts-expect-error Arrays are resolver results, not top-level scope definitions.
      scope: ["tenant-1", "user-1"],
    });
  });

  it("derives the default namespace from Vercel and slot context", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_123");
    vi.stubEnv("VERCEL_TARGET_ENV", "preview");

    const namespace = await contextStorage.run(createContext(), () =>
      runWithDefaultMemoryNamespaceContext(
        { appRoot: "/app", nodeId: "researcher", slot: "user" },
        () => defaultNamespace(),
      ),
    );

    expect(JSON.parse(namespace)).toEqual([
      "eve-memory-default-namespace-v1",
      ["vercel", "prj_123"],
      "preview",
      "researcher",
      "user",
    ]);
  });

  it("uses a hashed local app root in the default namespace", async () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    vi.stubEnv("VERCEL_TARGET_ENV", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "test");

    const namespace = await contextStorage.run(createContext(), () =>
      runWithDefaultMemoryNamespaceContext(
        { appRoot: "/private/application", nodeId: "__root__", slot: "memory" },
        () => defaultNamespace(),
      ),
    );
    const parsed = JSON.parse(namespace) as unknown[];

    expect(parsed).toMatchObject([
      "eve-memory-default-namespace-v1",
      ["local", expect.stringMatching(/^[A-Za-z0-9_-]{43}$/u)],
      "test",
      "__root__",
      "memory",
    ]);
    expect(namespace).not.toContain("/private/application");
  });

  it("requires defaultNamespace to run as a memory namespace resolver", () => {
    expect(() => defaultNamespace()).toThrow(/memory namespace context/u);
  });

  it("restores nested default namespace context and clears it after resolution", async () => {
    await contextStorage.run(createContext(), async () => {
      const slots = await runWithDefaultMemoryNamespaceContext(
        { appRoot: "/app", nodeId: "__root__", slot: "outer" },
        async () => {
          const before = JSON.parse(defaultNamespace()).at(-1);
          const inner = await runWithDefaultMemoryNamespaceContext(
            { appRoot: "/app", nodeId: "__root__", slot: "inner" },
            () => JSON.parse(defaultNamespace()).at(-1),
          );
          const after = JSON.parse(defaultNamespace()).at(-1);
          return { after, before, inner };
        },
      );

      expect(slots).toEqual({ after: "outer", before: "outer", inner: "inner" });
      expect(() => defaultNamespace()).toThrow(/memory namespace context/u);
    });
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
});
