import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import {
  MemoryOperationError,
  getMemoryToolOriginCallIds,
  projectMemoryPrompt,
  recordMemoryToolOrigins,
  releaseMemoryToolOrigins,
  resolveMemoryApprovalTools,
  resolveMemoryTools,
  restoreMemoryToolTurn,
  saveCompletedMemoryTurn,
  startMemoryCompaction,
  startMemoryTurn,
  finishMemoryCompaction,
  type MemoryDefaultNamespaceContext,
} from "#context/memory-lifecycle.js";
import { getMemoryState, setActiveMemoryToolOperations } from "#harness/memory-state.js";
import type { HarnessSession } from "#harness/types.js";
import { defineTool } from "#public/definitions/tool.js";
import {
  defaultNamespace,
  defineMemoryProvider,
  type MemoryProvider,
  type MemoryToolSet,
} from "#public/memory/index.js";
import { byPrincipal } from "#public/memory/scope.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";

const defaultNamespaceContext: MemoryDefaultNamespaceContext = {
  appRoot: "/app",
  nodeId: "__root__",
};

describe("memory lifecycle", () => {
  it("locks scopes in slot order and projects recall before normalized turn input", async () => {
    const calls: Array<{
      readonly input: readonly ModelMessage[];
      readonly messages: readonly ModelMessage[];
      readonly operationId: string;
      readonly phase: string;
      readonly scopeKey: string;
      readonly slot: string;
    }> = [];
    const makeProvider = (slot: string): MemoryProvider =>
      defineMemoryProvider({
        recall(context) {
          calls.push({
            input: context.turn?.input ?? [],
            messages: context.messages,
            operationId: context.operationId,
            phase: context.phase,
            scopeKey: context.memory.scope.key,
            slot,
          });
          return { content: `${slot} context` };
        },
      });
    const memories = [
      memory("workspace", makeProvider("workspace"), "workspace-1", "session"),
      memory("user", makeProvider("user"), byPrincipal),
    ];
    const prior = [{ content: "static and dynamic instructions", role: "user" }] as const;
    const turnInput = [{ content: "hello", role: "user" }] as const;

    const session = await runInContext(createContext(), () =>
      startMemoryTurn({
        defaultNamespaceContext,
        memories,
        messages: prior,
        projectionAnchorIndex: 1,
        session: createSession(prior),
        turn: { input: turnInput, sequence: 0, turnId: "turn_0" },
      }),
    );

    expect(calls.map(({ slot }) => slot)).toEqual(["user", "workspace"]);
    expect(calls.every(({ messages }) => messages !== prior && messages[0] === prior[0])).toBe(
      true,
    );
    expect(calls.map(({ input }) => input).every((input) => input[0] === turnInput[0])).toBe(true);
    expect(new Set(calls.map(({ operationId }) => operationId)).size).toBe(2);
    expect(new Set(calls.map(({ scopeKey }) => scopeKey)).size).toBe(2);
    expect(session.history).toEqual(prior);

    const prompt = projectMemoryPrompt({
      memories,
      messages: [...prior, ...turnInput],
      session,
    });
    expect(prompt).toEqual([
      prior[0],
      { content: "user context", role: "user" },
      { content: "workspace context", role: "user" },
      turnInput[0],
    ]);
    expect(session.compaction).toEqual({ recentWindowSize: 8, threshold: 10_000 });

    const continued = await runInContext(createContext(), () =>
      startMemoryTurn({
        defaultNamespaceContext,
        memories,
        messages: [...prior, ...turnInput],
        projectionAnchorIndex: 2,
        session,
        turn: {
          input: [{ content: "must not replace the admitted input", role: "user" }],
          sequence: 0,
          turnId: "turn_0",
        },
      }),
    );
    expect(continued).toBe(session);
    expect(calls).toHaveLength(2);
  });

  it("derives keys from only the explicit namespace and scope", async () => {
    const observed: Array<{
      readonly key: string;
      readonly namespace: string;
      readonly value: string;
    }> = [];
    const provider = defineMemoryProvider({
      recall(context) {
        observed.push(context.memory.scope);
      },
    });
    const cases = [
      {
        context: defaultNamespaceContext,
        definition: memory("user", provider, "tenant:user", "scope", "app-a"),
      },
      {
        context: defaultNamespaceContext,
        definition: memory("user", provider, "tenant:other", "scope", "app-a"),
      },
      {
        context: defaultNamespaceContext,
        definition: memory("user", provider, "tenant:user", "scope", "app-b"),
      },
      {
        context: defaultNamespaceContext,
        definition: memory("other-slot", provider, "tenant:user", "scope", "app-a"),
      },
      {
        context: { appRoot: "/other", nodeId: "researcher" },
        definition: memory("user", provider, "tenant:user", "scope", "app-a"),
      },
    ];

    for (const [sequence, testCase] of cases.entries()) {
      await runInContext(createContext(), () =>
        startMemoryTurn({
          defaultNamespaceContext: testCase.context,
          memories: [testCase.definition],
          messages: [],
          projectionAnchorIndex: 0,
          session: createSession(),
          turn: { input: [], sequence, turnId: `turn_${sequence}` },
        }),
      );
    }

    expect(observed.map(({ namespace, value }) => ({ namespace, value }))).toEqual([
      { namespace: "app-a", value: "tenant:user" },
      { namespace: "app-a", value: "tenant:other" },
      { namespace: "app-b", value: "tenant:user" },
      { namespace: "app-a", value: "tenant:user" },
      { namespace: "app-a", value: "tenant:user" },
    ]);
    expect(observed[0]!.key).not.toBe(observed[1]!.key);
    expect(observed[0]!.key).not.toBe(observed[2]!.key);
    expect(observed[0]!.key).toBe(observed[3]!.key);
    expect(observed[0]!.key).toBe(observed[4]!.key);
    expect(observed.every(({ key }) => /^mem_[A-Za-z0-9_-]{43}$/u.test(key))).toBe(true);
  });

  it("resolves promises and preserves default namespace context across awaits", async () => {
    let namespace: string | undefined;
    const definition = memory(
      "user",
      defineMemoryProvider({
        recall(context) {
          namespace = context.memory.scope.namespace;
        },
      }),
      Promise.resolve("user-1"),
      "scope",
      async () => {
        await Promise.resolve();
        return defaultNamespace();
      },
    );

    await runInContext(createContext(), () =>
      startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        projectionAnchorIndex: 0,
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      }),
    );

    expect(JSON.parse(namespace!)).toMatchObject([
      "eve-memory-default-namespace-v1",
      expect.any(Array),
      expect.any(String),
      "__root__",
      "user",
    ]);
    expect(namespace).not.toContain("/app");
  });

  it("rejects empty resolved namespace and scope values", async () => {
    const provider = defineMemoryProvider({ recall: () => undefined });
    const start = (definition: ResolvedMemoryDefinition) =>
      runInContext(createContext(), () =>
        startMemoryTurn({
          defaultNamespaceContext,
          memories: [definition],
          messages: [],
          projectionAnchorIndex: 0,
          session: createSession(),
          turn: { input: [], sequence: 0, turnId: "turn_0" },
        }),
      );

    await expect(start(memory("user", provider, () => ""))).rejects.toThrow(
      'Memory scope "user" must resolve to a non-empty string.',
    );
    await expect(start(memory("user", provider, "user-1", "scope", () => ""))).rejects.toThrow(
      'Memory namespace "user" must resolve to a non-empty string.',
    );
  });

  it("runs pre-save and post-recall with one compaction lock and durable ordinal", async () => {
    const calls: Array<{
      readonly current: string | null;
      readonly messages: readonly ModelMessage[];
      readonly operationId: string;
      readonly phase: string;
      readonly turnId: string | null;
    }> = [];
    const provider = defineMemoryProvider({
      recall(context) {
        calls.push({
          current: context.memory.current?.content ?? null,
          messages: context.messages,
          operationId: context.operationId,
          phase: context.phase,
          turnId: context.turn?.turnId ?? null,
        });
        return { content: context.phase === "turn.started" ? "before" : "after" };
      },
      save(context) {
        calls.push({
          current: context.memory.current?.content ?? null,
          messages: context.messages,
          operationId: context.operationId,
          phase: context.phase,
          turnId: context.turn?.turnId ?? null,
        });
      },
    });
    const definition = memory("user", provider, "user-1");
    const before: ModelMessage[] = [{ content: "before compaction", role: "user" }];
    const after: ModelMessage[] = [
      { content: "checkpoint", role: "user" },
      { content: "summary", role: "assistant" },
      { content: "recent", role: "user" },
    ];

    const result = await runInContext(createContext(), async () => {
      let session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        projectionAnchorIndex: 0,
        session: createSession(),
        turn: { input: before, sequence: 0, turnId: "turn_0" },
      });
      session = await startMemoryCompaction({
        defaultNamespaceContext,
        memories: [definition],
        messages: before,
        modelId: "mock/compact",
        session,
        standalone: false,
        usageInputTokens: 42,
      });
      return await finishMemoryCompaction({
        memories: [definition],
        messages: after,
        projectionAnchorIndex: 2,
        session,
      });
    });

    expect(result.failure).toBeUndefined();
    expect(calls.map(({ phase }) => phase)).toEqual([
      "turn.started",
      "compaction.requested",
      "compaction.completed",
    ]);
    expect(calls[1]).toMatchObject({ current: "before", messages: before, turnId: "turn_0" });
    expect(calls[2]).toMatchObject({ current: "before", messages: after, turnId: "turn_0" });
    expect(calls[1]!.operationId).not.toBe(calls[2]!.operationId);
    expect(getMemoryState(result.session)).toMatchObject({
      nextCompactionOrdinal: 1,
      pendingCompaction: null,
      projections: [{ anchorIndex: 2, content: "after", slot: "user" }],
    });
  });

  it("reuses logical operation ids across workflow replay", async () => {
    const calls: Array<{ readonly operationId: string; readonly phase: string }> = [];
    const definition = memory(
      "user",
      defineMemoryProvider({
        recall(context) {
          calls.push({ operationId: context.operationId, phase: context.phase });
        },
        save(context) {
          calls.push({ operationId: context.operationId, phase: context.phase });
        },
        tools(context) {
          calls.push({ operationId: context.operationId, phase: context.phase });
          return {};
        },
      }),
      "user-1",
    );

    const runLifecycle = async (): Promise<void> => {
      let session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        projectionAnchorIndex: 0,
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      });
      session = (
        await resolveMemoryTools({
          memories: [definition],
          messages: [],
          modelId: "mock/model",
          session,
        })
      ).session;
      session = await startMemoryCompaction({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        modelId: "mock/compact",
        session,
        standalone: false,
        usageInputTokens: 10,
      });
      session = (
        await finishMemoryCompaction({
          memories: [definition],
          messages: [],
          projectionAnchorIndex: 0,
          session,
        })
      ).session;
      await saveCompletedMemoryTurn({ memories: [definition], messages: [], session });
    };

    await runInContext(createContext(), async () => {
      await runLifecycle();
      await runLifecycle();
    });

    expect(calls.slice(0, 5).map(({ phase }) => phase)).toEqual([
      "turn.started",
      "step.started",
      "compaction.requested",
      "compaction.completed",
      "turn.completed",
    ]);
    expect(calls.slice(5)).toEqual(calls.slice(0, 5));
    expect(new Set(calls.slice(0, 5).map(({ operationId }) => operationId)).size).toBe(5);
  });

  it("returns compacted state with a content-free automatic post-recall failure", async () => {
    const provider = defineMemoryProvider({
      recall(context) {
        if (context.phase === "compaction.completed") {
          throw new Error("secret projection content");
        }
        return { content: "preserved" };
      },
    });
    const definition = memory("user", provider, "user-1");

    const result = await runInContext(createContext(), async () => {
      let session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        projectionAnchorIndex: 0,
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      });
      session = await startMemoryCompaction({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        modelId: "mock/compact",
        session,
        standalone: false,
        usageInputTokens: null,
      });
      return await finishMemoryCompaction({
        memories: [definition],
        messages: [{ content: "summary", role: "assistant" }],
        projectionAnchorIndex: 1,
        session,
      });
    });

    expect(result.failure).toBeInstanceOf(MemoryOperationError);
    expect(result.failure?.message).not.toContain("secret projection content");
    expect(getMemoryState(result.session)).toMatchObject({
      pendingCompaction: null,
      projections: [{ anchorIndex: 1, content: "preserved" }],
    });
  });

  it("settles a standalone post-recall failure after retaining the compacted checkpoint", async () => {
    const checkpoint: ModelMessage[] = [
      { content: "Summary of our conversation so far:", role: "user" },
      { content: "durable summary", role: "assistant" },
    ];
    const recalls: Array<{
      readonly messages: readonly ModelMessage[];
      readonly modelId: string;
      readonly turnId: string | null;
    }> = [];
    const definition = memory(
      "user",
      defineMemoryProvider({
        recall(context) {
          if (context.phase !== "compaction.completed") return;
          recalls.push({
            messages: context.messages,
            modelId: context.compaction.modelId,
            turnId: context.turn?.turnId ?? null,
          });
          throw new Error("private standalone projection failure");
        },
      }),
      "user-1",
    );

    const result = await runInContext(createContext(), async () => {
      const pending = await startMemoryCompaction({
        defaultNamespaceContext,
        memories: [definition],
        messages: [{ content: "history before compaction", role: "user" }],
        modelId: "mock/compact",
        session: createSession([{ content: "history before compaction", role: "user" }]),
        standalone: true,
        usageInputTokens: 42,
      });
      return await finishMemoryCompaction({
        memories: [definition],
        messages: checkpoint,
        projectionAnchorIndex: 2,
        session: { ...pending, history: checkpoint },
      });
    });

    expect(result.failure).toBeUndefined();
    expect(result.session.history).toEqual(checkpoint);
    expect(recalls).toEqual([{ messages: checkpoint, modelId: "mock/compact", turnId: null }]);
    expect(getMemoryState(result.session)).toMatchObject({
      nextCompactionOrdinal: 1,
      pendingCompaction: null,
    });
  });

  it("turns an empty recall projection into a content-free operation failure", async () => {
    const definition = memory(
      "user",
      defineMemoryProvider({ recall: () => ({ content: "" }) }),
      "user-1",
    );

    const operation = runInContext(createContext(), () =>
      startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        projectionAnchorIndex: 0,
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      }),
    );

    const error = await operation.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MemoryOperationError);
    expect(error).toMatchObject({
      phase: "turn.started",
      slot: "user",
    });
    expect((error as Error).message).not.toMatch(/projection content/u);
  });

  it("replaces the prior step tool set when tools returns null or an empty record", async () => {
    let invocation = 0;
    const initialTools: MemoryToolSet = {
      remember: defineTool({
        description: "Remember text",
        execute: () => undefined,
        inputSchema: { type: "object" },
      }),
    };
    const definition = memory(
      "user",
      defineMemoryProvider({
        recall: () => undefined,
        tools() {
          invocation += 1;
          if (invocation === 2) return null;
          if (invocation === 3) return {};
          return initialTools;
        },
      }),
      "user-1",
    );

    await runInContext(createContext(), async () => {
      const session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        projectionAnchorIndex: 0,
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      });
      const first = await resolveMemoryTools({
        memories: [definition],
        messages: [],
        modelId: "mock/model",
        session,
      });
      expect([...first.tools]).toHaveLength(1);

      const second = await resolveMemoryTools({
        memories: [definition],
        messages: [],
        modelId: "mock/model",
        session: first.session,
      });
      expect(second.tools.size).toBe(0);
      expect(getMemoryState(second.session).activeToolOperations).toEqual([]);

      const third = await resolveMemoryTools({
        memories: [definition],
        messages: [],
        modelId: "mock/model",
        session: second.session,
      });
      expect(third.tools.size).toBe(0);
      expect(getMemoryState(third.session).activeToolOperations).toEqual([]);
    });
  });

  it("qualifies direct tools and reconstructs a parked origin", async () => {
    const operationIds: string[] = [];
    const execute = vi.fn((input: unknown) => input);
    const provider = defineMemoryProvider({
      recall: () => undefined,
      tools(context) {
        operationIds.push(context.operationId);
        const scopeKey = context.memory.scope.key;
        return {
          remember: defineTool({
            approval: () => "user-approval",
            description: "Remember text",
            execute(input) {
              execute({ input, scopeKey });
              return input;
            },
            inputSchema: {
              additionalProperties: false,
              properties: { text: { type: "string" } },
              required: ["text"],
              type: "object",
            },
            toModelOutput: () => ({ type: "text", value: `origin:${scopeKey}` }),
          }),
        };
      },
    });
    const definition = memory("user", provider, "user-1");
    const ctx = createContext("issuer-a");

    const resolved = await runInContext(ctx, async () => {
      const started = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        projectionAnchorIndex: 0,
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      });
      return await resolveMemoryTools({
        memories: [definition],
        messages: [],
        modelId: "mock/model",
        session: started,
      });
    });
    const tool = resolved.tools.get("user__remember");
    expect(tool).toMatchObject({ description: "Remember text", name: "user__remember" });
    expect(JSON.stringify(resolved.session.state)).not.toContain("Remember text");

    const parked = recordMemoryToolOrigins({
      calls: [{ callId: "call-1", toolName: "user__remember" }],
      session: resolved.session,
    });
    expect(getMemoryToolOriginCallIds(parked)).toEqual(["call-1"]);
    const originalOrigin = getMemoryState(parked).toolOrigins["call-1"]!;
    const rerecorded = recordMemoryToolOrigins({
      calls: [
        {
          authorizationAttemptIds: ["attempt-1"],
          callId: "call-1",
          toolName: "user__remember",
        },
      ],
      session: setActiveMemoryToolOperations(parked, [
        {
          ...originalOrigin,
          operationId: "must-not-overwrite-origin",
          turnState: { ...originalOrigin.turnState, nextStepIndex: 2 },
        },
      ]),
    });
    expect(getMemoryState(rerecorded).toolOrigins["call-1"]?.operationId).toBe(
      originalOrigin.operationId,
    );
    await runInContext(ctx, async () => {
      expect(getMemoryToolOriginCallIds(rerecorded, ["attempt-1"])).toEqual(["call-1"]);
      expect(getMemoryToolOriginCallIds(rerecorded, ["attempt-other"])).toEqual([]);
    });
    expect(getMemoryState(rerecorded).toolOrigins["call-1"]?.turnState.nextStepIndex).toBe(2);
    const restored = restoreMemoryToolTurn({
      callIds: ["ordinary-call", "call-1"],
      projectionAnchorIndex: 0,
      session: parked,
    });
    expect(getMemoryState(restored).activeTurn?.turn.turnId).toBe("turn_0");

    const fallbackExecute = vi.fn();
    const approvalResolution = await runInContext(ctx, () =>
      resolveMemoryApprovalTools({
        callIds: ["ordinary-call", "call-1"],
        memories: [definition],
        session: parked,
      }),
    );
    const approvalTools = approvalResolution.select({
      callIds: ["call-1"],
      fallbackTools: new Map([
        [
          "user__remember",
          {
            description: "Current scope tool",
            execute: fallbackExecute,
            inputSchema: tool!.inputSchema,
            name: "user__remember",
            toModelOutput: () => ({ type: "text", value: "fallback" }),
          },
        ],
      ]),
    });
    expect(operationIds).toHaveLength(2);
    expect(operationIds[1]).toBe(operationIds[0]);
    expect(approvalTools.get("user__remember")?.description).toBe("Current scope tool");
    await runInContext(ctx, async () => {
      await approvalTools.get("user__remember")!.execute!(
        { text: "prefers terse answers" },
        { abortSignal: new AbortController().signal, messages: [], toolCallId: "call-1" },
      );
    });
    expect(execute).toHaveBeenCalledWith({
      input: { text: "prefers terse answers" },
      scopeKey: expect.stringMatching(/^mem_/u),
    });
    await approvalTools.get("user__remember")!.execute!(
      { text: "new call" },
      { abortSignal: new AbortController().signal, messages: [], toolCallId: "call-new" },
    );
    expect(fallbackExecute).toHaveBeenCalledOnce();
    const resumedTool = approvalTools.get("user__remember")!;
    expect(resumedTool.resolveToModelOutput?.("call-1")?.("result")).toEqual({
      type: "text",
      value: expect.stringMatching(/^origin:mem_/u),
    });
    expect(resumedTool.resolveToModelOutput?.("call-new")?.("result")).toEqual({
      type: "text",
      value: "fallback",
    });
    await runInContext(ctx, () =>
      resolveMemoryTools({
        memories: [definition],
        messages: [],
        modelId: "mock/model",
        session: restored,
      }),
    );
    expect(operationIds).toHaveLength(3);
    expect(operationIds[2]).not.toBe(operationIds[0]);

    setContextSession(ctx, "issuer-b");
    await expect(
      runInContext(ctx, () =>
        resolveMemoryApprovalTools({
          callIds: ["call-1"],
          memories: [definition],
          session: parked,
        }),
      ),
    ).resolves.toMatchObject({ tools: expect.any(Map) });
    expect(
      getMemoryState(releaseMemoryToolOrigins({ callIds: ["call-1"], session: parked }))
        .toolOrigins,
    ).toEqual({});
  });

  it("logs and continues completed saves without exposing the provider error", async () => {
    const completed: string[] = [];
    const failing = memory(
      "a",
      defineMemoryProvider({
        recall: () => undefined,
        save(context) {
          completed.push(context.phase);
          throw new Error("private completed history");
        },
      }),
      "a",
    );
    const succeeding = memory(
      "b",
      defineMemoryProvider({
        recall: () => undefined,
        save(context) {
          completed.push(context.phase);
        },
      }),
      "b",
    );

    const saved = await runInContext(createContext(), async () => {
      const session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [succeeding, failing],
        messages: [],
        projectionAnchorIndex: 0,
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      });
      return await saveCompletedMemoryTurn({
        memories: [succeeding, failing],
        messages: [{ content: "settled", role: "assistant" }],
        session,
      });
    });
    expect(completed).toEqual(["turn.completed", "turn.completed"]);
    expect(getMemoryState(saved).activeTurn).toBeNull();
  });

  it("suppresses every provider operation and projection when scope is null", async () => {
    const recall = vi.fn();
    const tools = vi.fn();
    const namespace = vi.fn(() => "must-not-resolve");
    const provider = defineMemoryProvider({ recall, tools });
    const definition = memory("user", provider, null, "session", namespace);

    const result = await runInContext(createContext(), async () => {
      const session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        projectionAnchorIndex: 0,
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      });
      return await resolveMemoryTools({
        memories: [definition],
        messages: [],
        modelId: "mock/model",
        session,
      });
    });

    expect(recall).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
    expect(namespace).not.toHaveBeenCalled();
    expect(result.tools.size).toBe(0);
    expect(
      projectMemoryPrompt({ memories: [definition], messages: [], session: result.session }),
    ).toEqual([]);
  });

  it("suppresses every provider operation and projection when namespace is null", async () => {
    const recall = vi.fn();
    const tools = vi.fn();
    const provider = defineMemoryProvider({ recall, tools });
    const definition = memory("user", provider, "user-1", "session", async () => null);

    const result = await runInContext(createContext(), async () => {
      const session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        projectionAnchorIndex: 0,
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      });
      return await resolveMemoryTools({
        memories: [definition],
        messages: [],
        modelId: "mock/model",
        session,
      });
    });

    expect(recall).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
    expect(result.tools.size).toBe(0);
    expect(
      projectMemoryPrompt({ memories: [definition], messages: [], session: result.session }),
    ).toEqual([]);
  });
});

function memory(
  slot: string,
  provider: MemoryProvider,
  scope: ResolvedMemoryDefinition["scope"],
  visibility: ResolvedMemoryDefinition["visibility"] = "scope",
  namespace: ResolvedMemoryDefinition["namespace"] = `test:${slot}`,
): ResolvedMemoryDefinition {
  return {
    logicalPath: `memory/${slot}.ts`,
    namespace,
    provider,
    scope,
    slot,
    sourceId: `memory/${slot}.ts`,
    sourceKind: "module",
    visibility,
  };
}

function createSession(history: readonly ModelMessage[] = []): HarnessSession {
  return {
    agent: {
      modelReference: { id: "mock/model" },
      system: "",
      tools: [],
    },
    compaction: {
      lastKnownInputTokens: 25,
      lastKnownPromptMessageCount: 1,
      recentWindowSize: 8,
      threshold: 10_000,
    },
    continuationToken: "http:session-1",
    history: [...history],
    sessionId: "session-1",
  };
}

function createContext(issuer = "issuer-a"): ContextContainer {
  const ctx = new ContextContainer();
  setContextSession(ctx, issuer);
  return ctx;
}

function setContextSession(ctx: ContextContainer, issuer: string): void {
  ctx.set(SessionKey, {
    auth: {
      current: {
        attributes: {},
        authenticator: "test",
        issuer,
        principalId: "user-1",
        principalType: "user",
      },
      initiator: null,
    },
    sessionId: "session-1",
    turn: { id: "turn_0", sequence: 0 },
  });
}

async function runInContext<T>(ctx: ContextContainer, callback: () => Promise<T>): Promise<T> {
  return await contextStorage.run(ctx, callback);
}
