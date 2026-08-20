import { z } from "#compiled/zod/index.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import { defineTool } from "#public/definitions/tool.js";
import type { MemoryToolSet } from "#public/memory/index.js";
import {
  defaultNamespace,
  defineMemory,
  defineMemoryProvider,
  getMemoryMessageAttribution,
} from "#public/memory/index.js";
import { attributeMemoryMessage } from "#shared/memory-message.js";

describe("memory authoring", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("defines the three-method provider contract without rewriting it", () => {
    const recall = () => ({ content: "remembered", role: "user" as const });
    const capture = async () => {};
    const tools = () => null;
    const scope = () => "user-1";
    const provider = defineMemoryProvider({ capture, recall, tools });
    const definition = defineMemory({
      description: "Personal memory.",
      namespace: "production",
      provider,
      scope,
      visibility: "session",
    });

    expect(provider).toEqual({ capture, recall, tools });
    expect(definition).toEqual({
      description: "Personal memory.",
      namespace: "production",
      provider,
      scope,
      visibility: "session",
    });
  });

  it("accepts scalar and resolver scope definitions", () => {
    const provider = defineMemoryProvider({ recall: () => undefined });

    expect(defineMemory({ provider, scope: "user-1" }).scope).toBe("user-1");
    expect(defineMemory({ namespace: null, provider, scope: "user-1" }).namespace).toBeNull();
    expect(defineMemory({ provider, scope: null }).scope).toBeNull();
    expect(
      defineMemory({
        namespace: async (ctx) => `app:${ctx.slot}`,
        provider,
        scope: async (ctx) => [ctx.session.id, "user-1"],
      }),
    ).toMatchObject({ provider });

    defineMemory({
      provider,
      // @ts-expect-error Bare promises are not scope definitions; use a resolver.
      scope: Promise.resolve("user-1"),
    });
    defineMemory({
      // @ts-expect-error Bare promises are not namespace definitions; use a resolver.
      namespace: Promise.resolve(null),
      provider,
      scope: "user-1",
    });
    defineMemory({
      provider,
      // @ts-expect-error Arrays are resolver results, not top-level scope definitions.
      scope: ["tenant-1", "user-1"],
    });
    defineMemory({
      // @ts-expect-error Memory descriptions are static strings.
      description: async () => "Personal memory.",
      provider,
      scope: "user-1",
    });
  });

  it("derives the default namespace from Vercel and slot context", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_123");
    vi.stubEnv("VERCEL_TARGET_ENV", "preview");

    const namespace = defaultNamespace({ appRoot: "/app", node: "researcher", slot: "user" });

    expect(JSON.parse(namespace)).toEqual([
      "eve-memory-default-namespace-v1",
      ["vercel", "prj_123"],
      "preview",
      "researcher",
      "user",
    ]);
  });

  it("uses a hashed local app root in the default namespace", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "");
    vi.stubEnv("VERCEL_OIDC_TOKEN", "");
    vi.stubEnv("VERCEL_TARGET_ENV", "");
    vi.stubEnv("VERCEL_ENV", "");
    vi.stubEnv("NODE_ENV", "test");

    const namespace = defaultNamespace({
      appRoot: "/private/application",
      node: "__root__",
      slot: "memory",
    });
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

  it("composes the default namespace inside a custom resolver", () => {
    vi.stubEnv("VERCEL_PROJECT_ID", "prj_123");
    vi.stubEnv("VERCEL_TARGET_ENV", "preview");

    const context = { appRoot: "/app", node: "__root__", slot: "user" };
    const definition = defineMemory({
      namespace: (ctx) => `${defaultNamespace(ctx)}:custom`,
      provider: defineMemoryProvider({ recall: () => undefined }),
      scope: "user-1",
    });
    const resolver = definition.namespace;

    expect(resolver(context)).toBe(`${defaultNamespace(context)}:custom`);
  });

  it("requires recall and rejects the removed event-map contract", () => {
    // @ts-expect-error Memory providers must implement recall.
    defineMemoryProvider({});
    defineMemoryProvider({
      // @ts-expect-error Memory providers do not expose lifecycle event maps.
      events: {},
      recall: () => undefined,
    });
    // Recall role is optional and defaults to "user".
    defineMemoryProvider({
      recall: () => ({ content: "defaulted role" }),
    });
    defineMemoryProvider({
      // @ts-expect-error Recall messages support only the user and system roles.
      recall: () => ({ content: "invalid", role: "assistant" }),
    });
  });

  it("reads cloned memory attribution without exposing internal metadata", () => {
    const message = attributeMemoryMessage(
      { content: "remembered", role: "user" },
      {
        scope: { key: "mem_key", namespace: "app", value: "user-1" },
        slot: "user",
      },
    );

    const attribution = getMemoryMessageAttribution(message);
    expect(attribution).toEqual({
      scope: { key: "mem_key", namespace: "app", value: "user-1" },
      slot: "user",
    });
    expect(attribution?.scope).not.toBe(getMemoryMessageAttribution(message)?.scope);
    expect(getMemoryMessageAttribution({ content: "ordinary", role: "user" })).toBeNull();
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
