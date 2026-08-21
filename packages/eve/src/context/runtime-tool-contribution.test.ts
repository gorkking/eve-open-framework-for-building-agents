import { jsonSchema } from "ai";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("#context/build-callback-context.js", () => ({
  buildCallbackContext: () => ({
    session: { id: "test", auth: { current: null, initiator: null }, turn: {} },
  }),
}));

// Import after mock so the module picks up the mock
const { contributeRuntimeTools, registerRuntimeToolContributor } =
  await import("#context/runtime-tool-contribution.js");
const { dispatchDynamicToolEvent, refreshDynamicSessionToolsForRuntimeRevision } =
  await import("#context/dynamic-tool-lifecycle.js");
const { buildDynamicTools, buildResponseAuthorizationTools } =
  await import("#context/build-dynamic-tools.js");

import { ContextContainer } from "#context/container.js";
import type { HarnessToolDefinition } from "#harness/execute-tool.js";
import type { DurableDynamicToolMetadata } from "#context/keys.js";
import {
  SessionDynamicToolMetadataKey,
  SessionDynamicToolRuntimeRevisionKey,
  TurnDynamicToolMetadataKey,
} from "#context/keys.js";
import { defineTool } from "#public/definitions/tool.js";
import type { DynamicToolEntry, DynamicToolSet } from "#shared/dynamic-tool-definition.js";
import { stampDurableDynamicToolCallbacks } from "#shared/durable-dynamic-tool-callbacks.js";
import { createSessionStartedEvent, type UnstampedMessageStreamEvent } from "#protocol/message.js";

import { SessionIdKey } from "#context/keys.js";

const CONTRIBUTOR_REGISTRY = Symbol.for("eve:runtime-tool-contributors");

function resetContributors(): void {
  (globalThis as Record<symbol, unknown[]>)[CONTRIBUTOR_REGISTRY] = [];
}

let contextCounter = 0;
function createCtx(sessionId = `test-session-${++contextCounter}`): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(SessionIdKey, sessionId);
  ctx.set(SessionDynamicToolRuntimeRevisionKey, "deployment:test");
  return ctx;
}

function makeEvent(type: string): UnstampedMessageStreamEvent {
  return { type, data: {} } as UnstampedMessageStreamEvent;
}

const executeOptions = { messages: [], toolCallId: "call_1" };

function createReplayableTool(
  description = "stub",
  executeFn: (input: Record<string, unknown>) => unknown = () => ({ ok: true }),
): DynamicToolEntry {
  const entry = defineTool({
    description,
    inputSchema: { type: "object" },
    execute: async (input: Record<string, unknown>): Promise<unknown> => executeFn(input),
  });
  stampDurableDynamicToolCallbacks(entry, {
    execute: {
      callback: (_closure, input) => executeFn(input as Record<string, unknown>),
      closure: {},
    },
  });
  return entry;
}

interface TestContributorOptions {
  readonly ownerId: string;
  readonly eventNames?: readonly ("session.started" | "turn.started" | "step.started")[];
  readonly prefix?: string;
  readonly tools:
    | DynamicToolSet
    | null
    | (() => DynamicToolSet | null | Promise<DynamicToolSet | null>);
}

function registerTestContributor(options: TestContributorOptions): void {
  const compute = options.tools;
  registerRuntimeToolContributor({
    ownerId: options.ownerId,
    slug: options.ownerId,
    logicalPath: `eve:${options.ownerId}`,
    sourceId: `eve:${options.ownerId}`,
    sourceKind: "module",
    eventNames: options.eventNames ?? ["turn.started"],
    contribute: () => (typeof compute === "function" ? compute() : compute),
  });
}

afterEach(() => {
  resetContributors();
});

describe("contributeRuntimeTools", () => {
  it("publishes a keyed branded tool through the same durable capture as authored dynamic tools", async () => {
    const ctx = createCtx();
    contributeRuntimeTools({
      coordinate: { event: "turn.started" },
      ctx,
      ownerId: "eve.test",
      runtimeRevision: "deployment:r1",
      sourceId: "eve:test",
      tools: { greet: createReplayableTool("hello tool") },
    });

    const metadata = ctx.get(TurnDynamicToolMetadataKey) ?? [];
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({
      contribution: {
        ownerId: "eve.test",
        runtimeRevision: "deployment:r1",
        sourceId: "eve:test",
      },
      name: "greet",
      resolverSlug: "eve.test",
    });
    const [tool] = buildDynamicTools(ctx);
    expect(tool!.name).toBe("greet");
    await expect(tool!.execute!({}, executeOptions)).resolves.toEqual({ ok: true });
  });

  it("qualifies names exactly once through the qualification prefix", () => {
    const ctx = createCtx();
    contributeRuntimeTools({
      coordinate: { event: "turn.started" },
      ctx,
      ownerId: "eve.memory",
      qualificationPrefix: "notes",
      runtimeRevision: "deployment:r1",
      sourceId: "eve:memory",
      tools: { save_memory: createReplayableTool(), remove_memory: createReplayableTool() },
    });

    expect((ctx.get(TurnDynamicToolMetadataKey) ?? []).map((entry) => entry.name)).toEqual([
      "notes__save_memory",
      "notes__remove_memory",
    ]);
  });

  it("lets two owners qualify the same local name without collision", () => {
    const ctx = createCtx();
    for (const ownerId of ["eve.one", "eve.two"]) {
      contributeRuntimeTools({
        coordinate: { event: "turn.started" },
        ctx,
        ownerId,
        qualificationPrefix: ownerId.replace("eve.", ""),
        runtimeRevision: "deployment:r1",
        sourceId: `eve:${ownerId}`,
        tools: { save: createReplayableTool() },
      });
    }

    expect((ctx.get(TurnDynamicToolMetadataKey) ?? []).map((entry) => entry.name)).toEqual([
      "one__save",
      "two__save",
    ]);
  });

  it("replaces an owner's active set while other owners remain", () => {
    const ctx = createCtx();
    contributeRuntimeTools({
      coordinate: { event: "turn.started" },
      ctx,
      ownerId: "a",
      runtimeRevision: "r",
      sourceId: "a",
      tools: { old_tool: createReplayableTool("v1") },
    });
    contributeRuntimeTools({
      coordinate: { event: "turn.started" },
      ctx,
      ownerId: "b",
      runtimeRevision: "r",
      sourceId: "b",
      tools: { b_tool: createReplayableTool("b") },
    });

    contributeRuntimeTools({
      coordinate: { event: "turn.started" },
      ctx,
      ownerId: "a",
      runtimeRevision: "r2",
      sourceId: "a",
      tools: { new_tool_a: createReplayableTool("v2"), new_tool_b: createReplayableTool("v3") },
    });

    expect((ctx.get(TurnDynamicToolMetadataKey) ?? []).map((entry) => entry.name)).toEqual([
      "b_tool",
      "new_tool_a",
      "new_tool_b",
    ]);
  });

  it("removes only the owner's prior contribution for null and for an empty map", () => {
    const ctx = createCtx();
    const base = {
      coordinate: { event: "turn.started" } as const,
      ctx,
      runtimeRevision: "r",
    };
    contributeRuntimeTools({
      ...base,
      ownerId: "a",
      sourceId: "a",
      tools: { a: createReplayableTool() },
    });
    contributeRuntimeTools({
      ...base,
      ownerId: "b",
      sourceId: "b",
      tools: { b: createReplayableTool() },
    });

    contributeRuntimeTools({ ...base, ownerId: "a", sourceId: "a", tools: null });
    expect((ctx.get(TurnDynamicToolMetadataKey) ?? []).map((entry) => entry.name)).toEqual(["b"]);

    contributeRuntimeTools({ ...base, ownerId: "b", sourceId: "b", tools: {} });
    expect(ctx.get(TurnDynamicToolMetadataKey)).toEqual([]);
  });

  it("rejects a lone branded tool, unbranded values, and invalid inputs without publishing", () => {
    const ctx = createCtx();
    const base = {
      coordinate: { event: "turn.started" } as const,
      ctx,
      ownerId: "a",
      runtimeRevision: "r",
      sourceId: "a",
    };

    // A lone branded tool passed instead of a keyed map.
    const loneBranded = createReplayableTool() as never;
    expect(() => contributeRuntimeTools({ ...base, tools: loneBranded })).toThrow(/keyed map/);
    expect(() =>
      contributeRuntimeTools({
        ...base,
        tools: {
          bad: {
            description: "no brand",
            inputSchema: { type: "object" },
            execute: () => null,
          } as DynamicToolEntry,
        },
      }),
    ).toThrow(/defineTool/);
    expect(() => contributeRuntimeTools({ ...base, ownerId: "", tools: null })).toThrow(/ownerId/);
    expect(ctx.get(TurnDynamicToolMetadataKey)).toBeUndefined();
  });
});

describe("dispatched runtime contributions", () => {
  it("runs registered contributors at their declared events and publishes their tools", async () => {
    const ctx = createCtx();
    registerTestContributor({
      ownerId: "eve.search",
      tools: { connection_search: createReplayableTool("search") },
    });

    await dispatchDynamicToolEvent({
      ctx,
      event: makeEvent("turn.started"),
      messages: [],
      resolvers: [],
    });

    const built = buildDynamicTools(ctx);
    expect(built.map((tool) => tool.name)).toEqual(["connection_search"]);
    await expect(built[0]!.execute!({}, executeOptions)).resolves.toEqual({ ok: true });
  });

  it("captures every valid entry when another owner fails validation", async () => {
    const ctx = createCtx();
    registerTestContributor({
      ownerId: "a",
      tools: () => ({
        good: createReplayableTool("good"),
        bad: {
          description: "unbranded",
          inputSchema: { type: "object" },
          execute: () => null,
        } as DynamicToolEntry,
      }),
    });
    registerTestContributor({ ownerId: "b", tools: { b_tool: createReplayableTool("b") } });

    await dispatchDynamicToolEvent({
      ctx,
      event: makeEvent("turn.started"),
      messages: [],
      resolvers: [],
    });

    // Owner A failed wholesale: no partial A set becomes callable.
    expect(buildDynamicTools(ctx).map((tool) => tool.name)).toEqual(["b_tool"]);
  });

  it("fails the operation when two owners collide on one qualified name", async () => {
    const ctx = createCtx();
    registerTestContributor({
      ownerId: "a",
      prefix: "same",
      tools: { x: createReplayableTool() },
    });
    registerTestContributor({
      ownerId: "b",
      prefix: "same",
      tools: { x: createReplayableTool() },
    });

    await expect(
      dispatchDynamicToolEvent({
        ctx,
        event: makeEvent("turn.started"),
        messages: [],
        resolvers: [],
      }),
    ).rejects.toThrow(/collides/);
  });

  it("keeps narrower scopes ahead of wider ones for same-name tools", async () => {
    const ctx = createCtx();
    registerRuntimeToolContributor({
      ownerId: "session-owner",
      slug: "session-owner",
      logicalPath: "eve:session-owner",
      sourceId: "session-owner",
      sourceKind: "module",
      eventNames: ["session.started"],
      contribute: () => ({ shared: createReplayableTool("session") }),
    });
    registerRuntimeToolContributor({
      ownerId: "step-owner",
      slug: "step-owner",
      logicalPath: "eve:step-owner",
      sourceId: "step-owner",
      sourceKind: "module",
      eventNames: ["step.started"],
      contribute: () => ({ shared: createReplayableTool("step") }),
    });

    await dispatchDynamicToolEvent({
      ctx,
      event: makeEvent("session.started"),
      messages: [],
      resolvers: [],
    });
    await dispatchDynamicToolEvent({
      ctx,
      event: makeEvent("step.started"),
      messages: [],
      resolvers: [],
    });

    const built = buildDynamicTools(ctx);
    const stepIndex = built.findIndex((tool) => tool.description === "step");
    const sessionIndex = built.findIndex((tool) => tool.description === "session");
    expect(stepIndex).toBeGreaterThanOrEqual(0);
    expect(sessionIndex).toBeGreaterThan(stepIndex);
    expect(built.filter((tool) => tool.name === "shared")).toHaveLength(2);
  });

  it("replaces authored static tools on name collision, following the established precedence", async () => {
    const ctx = createCtx();
    registerTestContributor({
      ownerId: "a",
      tools: () => ({ authored_name: createReplayableTool("dynamic winner") }),
    });
    await dispatchDynamicToolEvent({
      ctx,
      event: makeEvent("turn.started"),
      messages: [],
      resolvers: [],
    });

    const authoredTools = new Map([
      [
        "authored_name",
        {
          description: "authored loser",
          inputSchema: jsonSchema({ type: "object" }),
          name: "authored_name",
        } as HarnessToolDefinition,
      ],
    ]);
    const merged = buildResponseAuthorizationTools({ authoredTools, context: ctx });
    expect(merged.get("authored_name")!.description).toBe("dynamic winner");
  });

  it("retains contributed tools in cached step resolution across repeated coordinates", async () => {
    const ctx = createCtx();
    let calls = 0;
    registerRuntimeToolContributor({
      ownerId: "stepper",
      slug: "stepper",
      logicalPath: "eve:stepper",
      sourceId: "stepper",
      sourceKind: "module",
      eventNames: ["step.started"],
      contribute: () => {
        calls += 1;
        return { stepped: createReplayableTool("stepped") };
      },
    });

    const event = {
      data: { stepIndex: 0, turnId: "turn-1" },
      type: "step.started",
    } as UnstampedMessageStreamEvent;
    await dispatchDynamicToolEvent({ ctx, event, messages: [], resolvers: [] });
    await dispatchDynamicToolEvent({ ctx, event, messages: [], resolvers: [] });

    // The second dispatch replays the cached coordinate without re-running contributors.
    expect(calls).toBe(1);
    expect(buildDynamicTools(ctx).map((tool) => tool.name)).toEqual(["stepped"]);
  });

  it("rebinds contributed callbacks after a simulated cold start", async () => {
    const ctx = createCtx();
    registerTestContributor({ ownerId: "a", tools: { cold: createReplayableTool("cold") } });
    await dispatchDynamicToolEvent({
      ctx,
      event: makeEvent("turn.started"),
      messages: [],
      resolvers: [],
    });

    const registryGlobal = globalThis as Record<
      symbol,
      Map<string, Map<string, unknown>> | undefined
    >;
    const callbackRegistry = registryGlobal[Symbol.for("eve:dynamic-tool-callbacks")]!;
    callbackRegistry.delete("cold");

    // Replay fails closed while the binding is missing…
    const [missing] = buildDynamicTools(ctx);
    await expect(missing!.execute!({}, executeOptions)).rejects.toThrow(/cannot replay/);

    // …and the next boundary re-runs the contributor, restoring the binding.
    await dispatchDynamicToolEvent({
      ctx,
      event: makeEvent("turn.started"),
      messages: [],
      resolvers: [],
    });
    const [restored] = buildDynamicTools(ctx);
    await expect(restored!.execute!({}, executeOptions)).resolves.toEqual({ ok: true });
  });

  it("round-trips contribution provenance through context serialization", async () => {
    const ctx = createCtx();
    registerTestContributor({
      ownerId: "eve.search",
      tools: { persisted_tool: createReplayableTool("persisted") },
    });
    await dispatchDynamicToolEvent({
      ctx,
      event: makeEvent("turn.started"),
      messages: [],
      resolvers: [],
    });

    const { deserializeContext, serializeContext } = await import("#context/serialize.js");
    const restored = await deserializeContext(serializeContext(ctx));

    const metadata = restored.get(TurnDynamicToolMetadataKey) ?? [];
    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toMatchObject({
      contribution: {
        ownerId: "eve.search",
        runtimeRevision: "deployment:test",
        sourceId: "eve:eve.search",
      },
      name: "persisted_tool",
    });
  });

  it("cleans a contributor removed by a runtime revision during session refresh", async () => {
    const ctx = createCtx();
    registerRuntimeToolContributor({
      ownerId: "staying-owner",
      slug: "staying-owner",
      logicalPath: "eve:staying-owner",
      sourceId: "staying-owner",
      sourceKind: "module",
      eventNames: ["session.started"],
      contribute: () => ({ staying: createReplayableTool("staying") }),
    });
    registerRuntimeToolContributor({
      ownerId: "leaving-owner",
      slug: "leaving-owner",
      logicalPath: "eve:leaving-owner",
      sourceId: "leaving-owner",
      sourceKind: "module",
      eventNames: ["session.started"],
      contribute: () => ({ leaving: createReplayableTool("leaving") }),
    });
    ctx.set(SessionDynamicToolRuntimeRevisionKey, "deployment:dpl_1");
    await dispatchDynamicToolEvent({
      ctx,
      event: makeEvent("session.started"),
      messages: [],
      resolvers: [],
    });
    expect(
      buildDynamicTools(ctx)
        .map((tool) => tool.name)
        .sort(),
    ).toEqual(["leaving", "staying"]);

    resetContributors();
    registerRuntimeToolContributor({
      ownerId: "staying-owner",
      slug: "staying-owner",
      logicalPath: "eve:staying-owner",
      sourceId: "staying-owner",
      sourceKind: "module",
      eventNames: ["session.started"],
      contribute: () => ({ staying: createReplayableTool("staying-v2") }),
    });

    await refreshDynamicSessionToolsForRuntimeRevision({
      ctx,
      event: createSessionStartedEvent(),
      messages: [],
      resolvers: [],
      runtimeRevision: "deployment:dpl_2",
    });

    expect(buildDynamicTools(ctx).map((tool) => tool.name)).toEqual(["staying"]);
    expect(ctx.get(SessionDynamicToolRuntimeRevisionKey)).toBe("deployment:dpl_2");
  });

  it("keeps session contributions out of the resolver-replaced set only until republished", async () => {
    const ctx = createCtx();
    const resolver = {
      slug: "authored",
      eventNames: ["session.started"] as const,
      events: {
        "session.started": () => ({ from_resolver: createReplayableTool("resolver") }),
      },
      sourceId: "test:authored",
      sourceKind: "module" as const,
      logicalPath: "agent/tools/authored.ts",
    };
    registerTestContributor({
      eventNames: ["session.started"],
      ownerId: "contributor",
      tools: { from_contributor: createReplayableTool("contributor") },
    });

    await dispatchDynamicToolEvent({
      ctx,
      event: makeEvent("session.started"),
      messages: [],
      resolvers: [resolver],
    });

    const names = (ctx.get(SessionDynamicToolMetadataKey) ?? []).map(
      (entry: DurableDynamicToolMetadata) => entry.name,
    );
    expect(names).toEqual(["from_resolver", "from_contributor"]);
  });
});
