import type { ModelMessage } from "ai";
import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey, TurnMemoryStateKey } from "#context/keys.js";
import {
  createMemoryHookDefinitions,
  prepareMemoryLifecycleEvent,
  takePendingMemoryMessages,
} from "#context/memory-lifecycle.js";
import type { HookContext } from "#public/definitions/hook.js";
import { defineMemoryProvider, type MemoryProvider } from "#public/memory/index.js";
import {
  createCompactionCompletedEvent,
  createCompactionRequestedEvent,
  createInputRequestedEvent,
  createMessageReceivedEvent,
  createSessionStartedEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";

describe("memory lifecycle", () => {
  it("locks one scope and materializes messages returned from every provider event", async () => {
    const observed: Array<{ phase: string; messages: readonly ModelMessage[]; scopeKey: string }> =
      [];
    const scopeSignal = new AbortController().signal;
    const provider = defineMemoryProvider({
      events: {
        "compaction.requested"(_event, context) {
          observed.push({
            messages: context.messages,
            phase: "requested",
            scopeKey: context.memory.scope.key,
          });
          return { content: "requested memory" };
        },
        "compaction.completed"(_event, context) {
          observed.push({
            messages: context.messages,
            phase: "completed",
            scopeKey: context.memory.scope.key,
          });
          return { content: "completed memory" };
        },
        "message.received"(_event, context) {
          observed.push({
            messages: context.messages,
            phase: "message-received",
            scopeKey: context.memory.scope.key,
          });
          return [{ content: "message memory 1" }, { content: "message memory 2" }];
        },
        "turn.completed"(_event, context) {
          observed.push({
            messages: context.messages,
            phase: "turn-completed",
            scopeKey: context.memory.scope.key,
          });
          return { content: "turn-completed memory" };
        },
        "turn.started"(_event, context) {
          observed.push({
            messages: context.messages,
            phase: "turn-started",
            scopeKey: context.memory.scope.key,
          });
          return { content: "opening memory" };
        },
        "session.started"(_event, context) {
          observed.push({
            messages: context.messages,
            phase: "session-started",
            scopeKey: context.memory.scope.key,
          });
          return { content: "opening memory" };
        },
      },
    });
    const memory: ResolvedMemoryDefinition = {
      logicalPath: "memory/user.ts",
      provider,
      scope: async (context) => {
        expect(context.abortSignal).toBe(scopeSignal);
        return ["user-1"];
      },
      slot: "user",
      sourceId: "memory/user.ts",
      sourceKind: "module",
    };
    const ctx = createContext();
    const hooks = createMemoryHookDefinitions([memory])[0]!;
    const before: ModelMessage[] = [{ content: "before", role: "user" }];
    const after: ModelMessage[] = [{ content: "checkpoint", role: "system" }];
    const sessionStarted = stampMessageStreamEvent(createSessionStartedEvent());
    const turnStarted = stampMessageStreamEvent(
      createTurnStartedEvent({ sequence: 2, turnId: "turn-2" }),
    );
    const requested = stampMessageStreamEvent(
      createCompactionRequestedEvent({
        modelId: "mock/model",
        sequence: 2,
        sessionId: "session-1",
        turnId: "turn-2",
        usageInputTokens: 10,
      }),
    );
    const completed = stampMessageStreamEvent(
      createCompactionCompletedEvent({
        modelId: "mock/model",
        sequence: 2,
        sessionId: "session-1",
        turnId: "turn-2",
      }),
    );
    const turnCompleted = stampMessageStreamEvent(
      createTurnCompletedEvent({ sequence: 2, turnId: "turn-2" }),
    );
    const messageReceived = stampMessageStreamEvent(
      createMessageReceivedEvent({ message: "hello", sequence: 2, turnId: "turn-2" }),
    );
    const memoryMessages: readonly ModelMessage[] = [
      { content: "opening memory", role: "user" },
      { content: "opening memory", role: "user" },
      { content: "message memory 1", role: "user" },
      { content: "message memory 2", role: "user" },
      { content: "requested memory", role: "user" },
      { content: "completed memory", role: "user" },
    ];

    await contextStorage.run(ctx, async () => {
      await prepareMemoryLifecycleEvent({
        abortSignal: scopeSignal,
        ctx,
        event: sessionStarted,
        identity: { agentId: "agent-1", nodeId: "__root__" },
        memories: [memory],
      });
      await hooks.events["session.started"]!(sessionStarted, hookContext(before));
      await prepareMemoryLifecycleEvent({
        abortSignal: new AbortController().signal,
        ctx,
        event: turnStarted,
        identity: { agentId: "agent-1", nodeId: "__root__" },
        memories: [memory],
      });
      await hooks.events["turn.started"]!(turnStarted, hookContext(before));
      await hooks.events["message.received"]!(messageReceived, hookContext(before));
      await hooks.events["compaction.requested"]!(requested, hookContext(before));
      await hooks.events["compaction.completed"]!(completed, hookContext(after));

      expect(takePendingMemoryMessages()).toEqual(memoryMessages);
      expect(takePendingMemoryMessages()).toEqual([]);
      await prepareMemoryLifecycleEvent({
        abortSignal: new AbortController().signal,
        ctx,
        event: turnCompleted,
        identity: { agentId: "agent-1", nodeId: "__root__" },
        memories: [memory],
      });
      await hooks.events["turn.completed"]!(
        turnCompleted,
        hookContext([...after, ...memoryMessages]),
      );
      expect(takePendingMemoryMessages()).toEqual([
        { content: "turn-completed memory", role: "user" },
      ]);
      await hooks.events["turn.completed"]!(
        turnCompleted,
        hookContext([...after, ...memoryMessages]),
      );
      expect(takePendingMemoryMessages()).toEqual([]);
    });

    expect(observed.map(({ phase }) => phase)).toEqual([
      "session-started",
      "turn-started",
      "message-received",
      "requested",
      "completed",
      "turn-completed",
    ]);
    expect(observed.map(({ messages }) => messages)).toEqual([
      before,
      before,
      before,
      before,
      after,
      [...after, ...memoryMessages],
    ]);
    expect(new Set(observed.map(({ scopeKey }) => scopeKey)).size).toBe(1);
    expect(ctx.require(TurnMemoryStateKey).slots).toHaveLength(1);
  });

  it("keeps memory approval scope for the initiating principal", async () => {
    const memory: ResolvedMemoryDefinition = {
      logicalPath: "memory/user.ts",
      provider: defineMemoryProvider({}),
      scope: (context) => [context.session.auth.current!.principalId],
      slot: "user",
      sourceId: "memory/user.ts",
      sourceKind: "module",
    };
    const ctx = createContext();
    const requested = stampMessageStreamEvent(
      createInputRequestedEvent({
        requests: [
          {
            action: {
              callId: "call-1",
              input: { index: 1 },
              kind: "tool-call",
              toolName: "user__remove_memory",
            },
            kind: "tool-approval",
            prompt: "Allow this memory change?",
            requestId: "approval-1",
          },
        ],
        sequence: 2,
        stepIndex: 0,
        turnId: "turn-2",
      }),
    );
    const prepare = (event: Parameters<typeof prepareMemoryLifecycleEvent>[0]["event"]) =>
      prepareMemoryLifecycleEvent({
        abortSignal: new AbortController().signal,
        ctx,
        event,
        identity: { agentId: "agent-1", nodeId: "__root__" },
        memories: [memory],
      });
    const turnStarted = (sequence: number) =>
      stampMessageStreamEvent(createTurnStartedEvent({ sequence, turnId: `turn-${sequence}` }));

    await contextStorage.run(ctx, async () => {
      await prepare(turnStarted(2));
      const scopeKey = ctx.require(TurnMemoryStateKey).slots[0]!.scope.key;
      await prepare(requested);

      setSession(ctx, "user-1", 3);
      await prepare(turnStarted(3));
      expect(ctx.require(TurnMemoryStateKey)).toMatchObject({
        deferred: false,
        sequence: 3,
        slots: [{ scope: { key: scopeKey } }],
        turnId: "turn-3",
      });

      await prepare(requested);
      setSession(ctx, "user-1", 4, "other-issuer");
      await expect(prepare(turnStarted(4))).rejects.toThrow(
        /must be resumed by the principal that initiated it/u,
      );

      setSession(ctx, "user-2", 5);
      await expect(prepare(turnStarted(5))).rejects.toThrow(
        /must be resumed by the principal that initiated it/u,
      );
    });
  });

  it("resolves a fresh scope for standalone compaction", async () => {
    let scopeResolutions = 0;
    const memory: ResolvedMemoryDefinition = {
      logicalPath: "memory/user.ts",
      provider: defineMemoryProvider({}),
      scope: (context) => {
        scopeResolutions += 1;
        return [context.session.auth.current!.principalId];
      },
      slot: "user",
      sourceId: "memory/user.ts",
      sourceKind: "module",
    };
    const ctx = createContext();
    const prepare = (event: Parameters<typeof prepareMemoryLifecycleEvent>[0]["event"]) =>
      prepareMemoryLifecycleEvent({
        abortSignal: new AbortController().signal,
        ctx,
        event,
        identity: { agentId: "agent-1", nodeId: "__root__" },
        memories: [memory],
      });
    const compactionRequested = (sequence: number) =>
      stampMessageStreamEvent(
        createCompactionRequestedEvent({
          modelId: "mock/model",
          sequence,
          sessionId: "session-1",
          turnId: `turn-${sequence}`,
          usageInputTokens: 10,
        }),
      );
    const compactionCompleted = (sequence: number) =>
      stampMessageStreamEvent(
        createCompactionCompletedEvent({
          modelId: "mock/model",
          sequence,
          sessionId: "session-1",
          turnId: `turn-${sequence}`,
        }),
      );

    await contextStorage.run(ctx, async () => {
      await prepare(
        stampMessageStreamEvent(createTurnStartedEvent({ sequence: 2, turnId: "turn-2" })),
      );
      const activeTurnScope = ctx.require(TurnMemoryStateKey).slots[0]!.scope.key;

      await prepare(compactionRequested(2));
      expect(ctx.require(TurnMemoryStateKey).slots[0]!.scope.key).toBe(activeTurnScope);
      expect(scopeResolutions).toBe(1);

      setSession(ctx, "user-2", 3);
      await prepare(compactionRequested(3));
      const manualCompactionScope = ctx.require(TurnMemoryStateKey).slots[0]!.scope.key;
      expect(manualCompactionScope).not.toBe(activeTurnScope);
      expect(scopeResolutions).toBe(2);

      await prepare(compactionCompleted(3));
      expect(ctx.require(TurnMemoryStateKey).slots[0]!.scope.key).toBe(manualCompactionScope);
      expect(scopeResolutions).toBe(2);
    });
  });

  it("rejects legacy bare string event results at runtime", async () => {
    const provider: MemoryProvider = defineMemoryProvider({ events: {} });
    Object.assign(provider.events!, { "turn.started": () => "legacy memory" });
    const memory: ResolvedMemoryDefinition = {
      logicalPath: "memory/user.ts",
      provider,
      scope: () => ["user-1"],
      slot: "user",
      sourceId: "memory/user.ts",
      sourceKind: "module",
    };
    const ctx = createContext();
    const event = stampMessageStreamEvent(
      createTurnStartedEvent({ sequence: 2, turnId: "turn-2" }),
    );
    const hook = createMemoryHookDefinitions([memory])[0]!.events["turn.started"]!;

    await contextStorage.run(ctx, async () => {
      await prepareMemoryLifecycleEvent({
        abortSignal: new AbortController().signal,
        ctx,
        event,
        identity: { agentId: "agent-1", nodeId: "__root__" },
        memories: [memory],
      });
      await expect(hook(event, hookContext([]))).rejects.toThrow(
        'Memory provider "user" must return { content: string }, an array of messages, null, or undefined.',
      );
    });
  });
});

function createContext(): ContextContainer {
  const ctx = new ContextContainer();
  setSession(ctx, "user-1", 2);
  return ctx;
}

function setSession(
  ctx: ContextContainer,
  principalId: string,
  sequence: number,
  issuer?: string,
): void {
  ctx.set(SessionKey, {
    auth: {
      current: {
        attributes: {},
        authenticator: "test",
        issuer,
        principalId,
        principalType: "user",
      },
      initiator: null,
    },
    sessionId: "session-1",
    turn: { id: `turn-${sequence}`, sequence },
  });
}

function hookContext(messages: readonly ModelMessage[]): HookContext {
  return {
    abortSignal: new AbortController().signal,
    agent: { name: "agent", nodeId: "__root__" },
    channel: {},
    getSandbox: async () => {
      throw new Error("not available");
    },
    getSkill: () => {
      throw new Error("not available");
    },
    messages,
    session: {
      auth: { current: null, initiator: null },
      id: "session-1",
      turn: { id: "turn-2", sequence: 2 },
    },
  };
}
