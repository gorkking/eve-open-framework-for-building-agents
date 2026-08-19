import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  SessionIdKey,
  SessionKey,
} from "#context/keys.js";
import {
  MemoryOperationError,
  buildMemoryTools,
  getMemoryToolOriginCallIds,
  prepareMemoryCompaction,
  projectMemoryPrompt,
  recordMemoryToolOrigins,
  releaseMemoryToolOrigins,
  resolveMemoryApprovalTools,
  restoreMemoryToolTurn,
  saveCompletedMemoryTurn,
  startMemoryCompaction as runMemoryCompactionSaves,
  startMemoryTurn,
  finishMemoryCompaction,
  type MemoryDefaultNamespaceContext,
} from "#context/memory-lifecycle.js";
import { getMemoryState } from "#harness/memory-state.js";
import type { HarnessSession } from "#harness/types.js";
import { defineTool } from "#public/definitions/tool.js";
import {
  defaultNamespace,
  defineMemoryProvider,
  getMemoryMessageAttribution,
  type MemoryProvider,
  type MemoryRecallResult,
  type MemoryScopeContext,
  type MemoryToolSet,
} from "#public/memory/index.js";
import { byPrincipal } from "#public/memory/scope.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";

const defaultNamespaceContext: MemoryDefaultNamespaceContext = {
  appRoot: "/app",
  nodeId: "__root__",
};

describe("memory lifecycle", () => {
  it("locks scopes in slot order and appends recall before normalized turn input", async () => {
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
          return { content: `${slot} context`, role: "user" };
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
    expect(session.history.map(({ content, role }) => ({ content, role }))).toEqual([
      prior[0],
      { content: "user context", role: "user" },
      { content: "workspace context", role: "user" },
    ]);
    expect(getMemoryMessageAttribution(session.history[1]!)).toMatchObject({ slot: "user" });
    expect(getMemoryMessageAttribution(session.history[2]!)).toMatchObject({ slot: "workspace" });

    const prompt = projectMemoryPrompt({
      memories,
      messages: [...session.history, ...turnInput],
      session,
    });
    expect(prompt).toEqual([...session.history, turnInput[0]]);
    expect(session.compaction).toMatchObject({
      lastKnownInputTokens: 25,
      lastKnownPromptMessageCount: 1,
    });

    const continued = await runInContext(createContext(), () =>
      startMemoryTurn({
        defaultNamespaceContext,
        memories,
        messages: [...prior, ...turnInput],
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

  it("passes trusted request context, joins resolver components, and reuses the turn lock", async () => {
    const controller = new AbortController();
    const contexts: MemoryScopeContext[] = [];
    const scope = vi.fn(async (context) => {
      contexts.push(context);
      const channelId = context.channel.metadata?.channelId;
      return typeof channelId === "string" ? [context.session.id, channelId] : null;
    });
    const values: string[] = [];
    const definition = memory(
      "channel",
      defineMemoryProvider({
        recall(context) {
          values.push(context.memory.scope.value);
        },
      }),
      scope,
    );
    const context = createContext();
    context.set(ChannelKey, { kind: "channel:slack" });
    context.set(ContinuationTokenKey, "slack:T123:C123:thread-1");
    context.set(ChannelInstrumentationKey, {
      kind: "channel:slack",
      metadata: { channelId: "C123", teamId: "T123" },
    });

    const turnSession = await runInContext(context, () =>
      startMemoryTurn({
        abortSignal: controller.signal,
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      }),
    );
    await runInContext(context, () =>
      startMemoryCompaction({
        abortSignal: controller.signal,
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        modelId: "mock/compact",
        session: turnSession,
        standalone: false,
        usageInputTokens: null,
      }),
    );

    expect(scope).toHaveBeenCalledTimes(1);
    expect(values).toEqual(["session-1:C123"]);
    expect(contexts[0]).toMatchObject({
      abortSignal: controller.signal,
      channel: {
        continuationToken: "slack:T123:C123:thread-1",
        kind: "channel:slack",
        metadata: { channelId: "C123", teamId: "T123" },
      },
      session: {
        auth: { current: { principalId: "user-1" }, initiator: null },
        id: "session-1",
      },
    });
    expect("messages" in contexts[0]!).toBe(false);

    await runInContext(context, () =>
      startMemoryCompaction({
        abortSignal: controller.signal,
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        modelId: "mock/compact",
        session: createSession(),
        standalone: true,
        usageInputTokens: null,
      }),
    );
    expect(scope).toHaveBeenCalledTimes(2);
    expect(contexts[1]).toMatchObject(contexts[0]!);
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
    await expect(start(memory("user", provider, async () => []))).rejects.toThrow(
      'Memory scope "user" resolver must return a non-empty array of non-empty strings.',
    );
    await expect(start(memory("user", provider, () => ["tenant-1", ""]))).rejects.toThrow(
      'Memory scope "user" resolver must return a non-empty array of non-empty strings.',
    );
  });

  it("runs pre-save and post-recall with one compaction lock and durable ordinal", async () => {
    const calls: Array<{
      readonly messages: readonly ModelMessage[];
      readonly operationId: string;
      readonly phase: string;
      readonly turnId: string | null;
    }> = [];
    const provider = defineMemoryProvider({
      recall(context) {
        calls.push({
          messages: context.messages,
          operationId: context.operationId,
          phase: context.phase,
          turnId: context.turn?.turnId ?? null,
        });
        return {
          content: context.phase === "turn.started" ? "before" : "after",
          role: "user",
        };
      },
      save(context) {
        calls.push({
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
        session,
      });
    });

    expect(result.failure).toBeUndefined();
    expect(calls.map(({ phase }) => phase)).toEqual([
      "turn.started",
      "compaction.requested",
      "compaction.completed",
    ]);
    expect(calls[1]).toMatchObject({ messages: before, turnId: "turn_0" });
    expect(calls[2]).toMatchObject({ messages: after, turnId: "turn_0" });
    expect(calls[1]!.operationId).not.toBe(calls[2]!.operationId);
    expect(getMemoryState(result.session)).toMatchObject({
      nextCompactionOrdinal: 1,
      pendingCompaction: null,
    });
    expect(result.session.history.map(({ content, role }) => ({ content, role }))).toEqual([
      ...after,
      { content: "after", role: "user" },
    ]);
    expect(getMemoryMessageAttribution(result.session.history.at(-1)!)).toMatchObject({
      slot: "user",
    });
  });

  it("reuses recall and save operation ids across workflow replay", async () => {
    const calls: Array<{ readonly operationId: string; readonly phase: string }> = [];
    const tools = vi.fn(() => ({}));
    const definition = memory(
      "user",
      defineMemoryProvider({
        recall(context) {
          calls.push({ operationId: context.operationId, phase: context.phase });
        },
        save(context) {
          calls.push({ operationId: context.operationId, phase: context.phase });
        },
        tools,
      }),
      "user-1",
    );

    const runLifecycle = async (): Promise<void> => {
      let session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
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
        usageInputTokens: 10,
      });
      session = (
        await finishMemoryCompaction({
          memories: [definition],
          messages: [],
          session,
        })
      ).session;
      await saveCompletedMemoryTurn({ memories: [definition], messages: [], session });
    };

    await runInContext(createContext(), async () => {
      await runLifecycle();
      await runLifecycle();
    });

    expect(calls.slice(0, 4).map(({ phase }) => phase)).toEqual([
      "turn.started",
      "compaction.requested",
      "compaction.completed",
      "turn.completed",
    ]);
    expect(calls.slice(4)).toEqual(calls.slice(0, 4));
    expect(new Set(calls.slice(0, 4).map(({ operationId }) => operationId)).size).toBe(4);
    expect(tools).toHaveBeenCalledTimes(2);
  });

  it("returns compacted state with a content-free automatic post-recall failure", async () => {
    const provider = defineMemoryProvider({
      recall(context) {
        if (context.phase === "compaction.completed") {
          throw new Error("secret recall content");
        }
        return { content: "preserved", role: "user" };
      },
    });
    const definition = memory("user", provider, "user-1");

    const result = await runInContext(createContext(), async () => {
      let session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
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
        session,
      });
    });

    expect(result.failure).toBeInstanceOf(MemoryOperationError);
    expect(result.failure?.message).not.toContain("secret recall content");
    expect(getMemoryState(result.session)).toMatchObject({
      pendingCompaction: null,
    });
    expect(result.session.history).toEqual([{ content: "summary", role: "assistant" }]);
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
          throw new Error("private standalone recall failure");
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

  it("treats an empty recall message as no append", async () => {
    const definition = memory(
      "user",
      defineMemoryProvider({ recall: () => ({ content: "", role: "user" }) }),
      "user-1",
    );

    const session = await runInContext(createContext(), () =>
      startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      }),
    );

    expect(session.history).toEqual([]);
  });

  it("leaves earlier recall untouched when a later boundary returns null", async () => {
    const definition = memory(
      "user",
      defineMemoryProvider({
        recall: (context) =>
          context.phase === "turn.started" && context.turn.sequence === 0
            ? { content: "first", role: "user" }
            : null,
      }),
      "user-1",
    );

    const session = await runInContext(createContext(), async () => {
      const first = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      });
      return await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: first.history,
        session: first,
        turn: { input: [], sequence: 1, turnId: "turn_1" },
      });
    });

    expect(session.history.map(({ content, role }) => ({ content, role }))).toEqual([
      { content: "first", role: "user" },
    ]);
  });

  it("rejects a non-user recall result at runtime", async () => {
    const invalidResult: unknown = { content: "system memory", role: "system" };
    const provider: MemoryProvider = {
      recall: () => invalidResult as MemoryRecallResult,
    };

    await expect(
      runInContext(createContext(), () =>
        startMemoryTurn({
          defaultNamespaceContext,
          memories: [memory("user", provider, "user-1")],
          messages: [],
          session: createSession(),
          turn: { input: [], sequence: 0, turnId: "turn_0" },
        }),
      ),
    ).rejects.toMatchObject({ phase: "turn.started", slot: "user" });
  });

  it("resolves tools once per turn and replaces the prior turn's set", async () => {
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
      let session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      });
      expect([...buildMemoryTools(session)]).toHaveLength(1);
      expect([...buildMemoryTools(session)]).toHaveLength(1);
      expect(invocation).toBe(1);

      session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        session,
        turn: { input: [], sequence: 1, turnId: "turn_1" },
      });
      expect(buildMemoryTools(session).size).toBe(0);
      expect(invocation).toBe(2);

      session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        session,
        turn: { input: [], sequence: 2, turnId: "turn_2" },
      });
      expect(buildMemoryTools(session).size).toBe(0);
      expect(invocation).toBe(3);
    });
  });

  it("prepends each slot description without exposing its address or mutating provider tools", async () => {
    const remember = defineTool({
      description: "Remember one value.",
      execute: () => undefined,
      inputSchema: { type: "object" },
    });
    const provider = defineMemoryProvider({
      recall: () => undefined,
      tools: () => ({ remember }),
    });
    const memories = [
      memory(
        "channel",
        provider,
        "private-channel-scope",
        "scope",
        "private-channel-namespace",
        "Shared channel conventions.",
      ),
      memory(
        "personal",
        provider,
        "private-personal-scope",
        "scope",
        "private-personal-namespace",
        "Personal preferences.",
      ),
    ];

    const session = await runInContext(createContext(), () =>
      startMemoryTurn({
        defaultNamespaceContext,
        memories,
        messages: [],
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      }),
    );
    const tools = buildMemoryTools(session);

    expect(tools.get("channel__remember")?.description).toBe(
      "Shared channel conventions.\n\nRemember one value.",
    );
    expect(tools.get("personal__remember")?.description).toBe(
      "Personal preferences.\n\nRemember one value.",
    );
    expect(JSON.stringify([...tools.values()].map(({ description }) => description))).not.toMatch(
      /private-(channel|personal)-(namespace|scope)/u,
    );
    expect(remember.description).toBe("Remember one value.");
  });

  it("passes async tools the dynamic resolver context after recall", async () => {
    const observed: unknown[] = [];
    const prior = [{ content: "prior", role: "user" }] as const;
    const input = [{ content: "current", role: "user" }] as const;
    const definition = memory(
      "user",
      defineMemoryProvider({
        recall: () => ({ content: "recalled", role: "user" }),
        async tools(context) {
          await Promise.resolve();
          observed.push({
            issuer: context.session.auth.current?.issuer,
            messages: context.messages,
            sessionId: context.session.id,
            turn: context.turn,
          });
          return {};
        },
      }),
      "user-1",
    );

    await runInContext(createContext("issuer-dynamic"), () =>
      startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: prior,
        session: createSession(prior),
        turn: { input, sequence: 0, turnId: "turn_0" },
      }),
    );

    expect(observed).toEqual([
      {
        issuer: "issuer-dynamic",
        messages: [
          ...prior,
          expect.objectContaining({ content: "recalled", role: "user" }),
          ...input,
        ],
        sessionId: "session-1",
        turn: { input, sequence: 0, turnId: "turn_0" },
      },
    ]);
  });

  it("omits a throwing tool resolver for the turn", async () => {
    const definition = memory(
      "user",
      defineMemoryProvider({
        recall: () => undefined,
        tools: async () => {
          throw new Error("private resolver failure");
        },
      }),
      "user-1",
    );

    const session = await runInContext(createContext(), () =>
      startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      }),
    );

    expect(buildMemoryTools(session)).toEqual(new Map());
  });

  it("omits a single tool returned where a provider tool map is required", async () => {
    const singleTool = defineTool({
      description: "Invalid single tool",
      execute: () => null,
      inputSchema: { type: "object" },
    });
    const invalidResult: unknown = singleTool;
    const definition = memory(
      "user",
      defineMemoryProvider({
        recall: () => undefined,
        tools: () => invalidResult as MemoryToolSet,
      }),
      "user-1",
    );

    const session = await runInContext(createContext(), () =>
      startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      }),
    );

    expect(buildMemoryTools(session)).toEqual(new Map());
  });

  it("qualifies provider tools and reconstructs a parked origin", async () => {
    const resolutions: Array<{ readonly scopeKey: string; readonly turnId: string }> = [];
    const execute = vi.fn((input: unknown) => input);
    const provider = defineMemoryProvider({
      recall: () => undefined,
      tools(context) {
        const scopeKey = context.memory.scope.key;
        resolutions.push({ scopeKey, turnId: context.turn.turnId });
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
    const definition = memory("user", provider, "user-1", "scope", "test:user", "Personal memory.");
    const ctx = createContext("issuer-a");

    const resolved = await runInContext(ctx, async () => {
      const session = await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      });
      return { session, tools: buildMemoryTools(session) };
    });
    const tool = resolved.tools.get("user__remember");
    expect(tool).toMatchObject({
      description: "Personal memory.\n\nRemember text",
      name: "user__remember",
    });
    expect(resolutions).toHaveLength(1);

    const parked = recordMemoryToolOrigins({
      calls: [{ callId: "call-1", toolName: "user__remember" }],
      session: resolved.session,
    });
    expect(getMemoryToolOriginCallIds(parked)).toEqual(["call-1"]);
    const originalOrigin = getMemoryState(parked).toolOrigins["call-1"]!;
    expect(originalOrigin.toolMetadata.description).toBe("Personal memory.\n\nRemember text");
    const rerecorded = recordMemoryToolOrigins({
      calls: [
        {
          authorizationAttemptIds: ["attempt-1"],
          callId: "call-1",
          toolName: "user__remember",
        },
      ],
      session: parked,
    });
    expect(getMemoryState(rerecorded).toolOrigins["call-1"]?.toolMetadata).toEqual(
      originalOrigin.toolMetadata,
    );
    await runInContext(ctx, async () => {
      expect(getMemoryToolOriginCallIds(rerecorded, ["attempt-1"])).toEqual(["call-1"]);
      expect(getMemoryToolOriginCallIds(rerecorded, ["attempt-other"])).toEqual([]);
    });
    const restored = restoreMemoryToolTurn({
      callIds: ["ordinary-call", "call-1"],
      session: parked,
    });
    expect(getMemoryState(restored).activeTurn?.turn.turnId).toBe("turn_0");

    const fallbackExecute = vi.fn();
    const approvalResolution = await runInContext(ctx, () =>
      resolveMemoryApprovalTools({
        callIds: ["ordinary-call", "call-1"],
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
    expect(resolutions).toHaveLength(1);
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
    expect(buildMemoryTools(restored).get("user__remember")?.description).toBe(
      "Personal memory.\n\nRemember text",
    );
    expect(resolutions).toHaveLength(1);

    setContextSession(ctx, "issuer-b");
    await expect(
      runInContext(ctx, () =>
        resolveMemoryApprovalTools({
          callIds: ["call-1"],
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

  it("suppresses every provider operation and recall when scope is null", async () => {
    const recall = vi.fn();
    const tools = vi.fn();
    const namespace = vi.fn(() => "must-not-resolve");
    const provider = defineMemoryProvider({ recall, tools });
    const definition = memory("user", provider, null, "session", namespace);

    const session = await runInContext(createContext(), async () => {
      return await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      });
    });

    expect(recall).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
    expect(namespace).not.toHaveBeenCalled();
    expect(buildMemoryTools(session).size).toBe(0);
    expect(projectMemoryPrompt({ memories: [definition], messages: [], session })).toEqual([]);
  });

  it("suppresses every provider operation and recall when namespace is null", async () => {
    const recall = vi.fn();
    const tools = vi.fn();
    const provider = defineMemoryProvider({ recall, tools });
    const definition = memory("user", provider, "user-1", "session", async () => null);

    const session = await runInContext(createContext(), async () => {
      return await startMemoryTurn({
        defaultNamespaceContext,
        memories: [definition],
        messages: [],
        session: createSession(),
        turn: { input: [], sequence: 0, turnId: "turn_0" },
      });
    });

    expect(recall).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
    expect(buildMemoryTools(session).size).toBe(0);
    expect(projectMemoryPrompt({ memories: [definition], messages: [], session })).toEqual([]);
  });
});

async function startMemoryCompaction(
  input: Parameters<typeof prepareMemoryCompaction>[0] &
    Pick<Parameters<typeof runMemoryCompactionSaves>[0], "messages" | "usageInputTokens">,
): Promise<HarnessSession> {
  const prepared = await prepareMemoryCompaction(input);
  return await runMemoryCompactionSaves({
    abortSignal: input.abortSignal,
    memories: input.memories,
    messages: input.messages,
    session: prepared,
    usageInputTokens: input.usageInputTokens,
  });
}

function memory(
  slot: string,
  provider: MemoryProvider,
  scope: ResolvedMemoryDefinition["scope"],
  visibility: ResolvedMemoryDefinition["visibility"] = "scope",
  namespace: ResolvedMemoryDefinition["namespace"] = `test:${slot}`,
  description?: string,
): ResolvedMemoryDefinition {
  return {
    description,
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
  const current = {
    attributes: {},
    authenticator: "test",
    issuer,
    principalId: "user-1",
    principalType: "user" as const,
  };
  ctx.set(AuthKey, current);
  ctx.set(InitiatorAuthKey, null);
  ctx.set(SessionIdKey, "session-1");
  ctx.set(SessionKey, {
    auth: { current, initiator: null },
    sessionId: "session-1",
    turn: { id: "turn_0", sequence: 0 },
  });
}

async function runInContext<T>(ctx: ContextContainer, callback: () => Promise<T>): Promise<T> {
  return await contextStorage.run(ctx, callback);
}
