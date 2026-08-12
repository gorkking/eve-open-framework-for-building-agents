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
import { defineMemoryProvider } from "#public/memory/index.js";
import {
  createCompactionCompletedEvent,
  createCompactionRequestedEvent,
  createInputRequestedEvent,
  createMessageReceivedEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
  stampMessageStreamEvent,
} from "#protocol/message.js";
import type { ResolvedMemoryDefinition } from "#runtime/types.js";

describe("memory lifecycle", () => {
  it("locks one scope and materializes messages returned from real turn events", async () => {
    const observed: Array<{ phase: string; messages: readonly ModelMessage[]; scopeKey: string }> =
      [];
    const provider = defineMemoryProvider({
      events: {
        "compaction.requested"(_event, context) {
          observed.push({
            messages: context.messages,
            phase: "requested",
            scopeKey: context.memory.scope.key,
          });
        },
        "compaction.completed"(_event, context) {
          observed.push({
            messages: context.messages,
            phase: "completed",
            scopeKey: context.memory.scope.key,
          });
        },
        "message.received"(_event, context) {
          observed.push({
            messages: context.messages,
            phase: "message-received",
            scopeKey: context.memory.scope.key,
          });
          return "message memory";
        },
        "turn.completed"(_event, context) {
          observed.push({
            messages: context.messages,
            phase: "turn-completed",
            scopeKey: context.memory.scope.key,
          });
        },
        "turn.started"(_event, context) {
          observed.push({
            messages: context.messages,
            phase: "turn-started",
            scopeKey: context.memory.scope.key,
          });
          return "turn memory";
        },
      },
    });
    const memory: ResolvedMemoryDefinition = {
      logicalPath: "memory/user.ts",
      provider,
      scope: () => ["user-1"],
      slot: "user",
      sourceId: "memory/user.ts",
      sourceKind: "module",
    };
    const ctx = createContext();
    const hooks = createMemoryHookDefinitions([memory])[0]!;
    const before: ModelMessage[] = [{ content: "before", role: "user" }];
    const after: ModelMessage[] = [{ content: "checkpoint", role: "system" }];
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
      { content: "turn memory", role: "user" },
      { content: "message memory", role: "user" },
    ];

    await contextStorage.run(ctx, async () => {
      prepareMemoryLifecycleEvent({
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
      prepareMemoryLifecycleEvent({
        ctx,
        event: turnCompleted,
        identity: { agentId: "agent-1", nodeId: "__root__" },
        memories: [memory],
      });
      await hooks.events["turn.completed"]!(
        turnCompleted,
        hookContext([...after, ...memoryMessages]),
      );
    });

    expect(observed.map(({ phase }) => phase)).toEqual([
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
      after,
      [...after, ...memoryMessages],
    ]);
    expect(new Set(observed.map(({ scopeKey }) => scopeKey)).size).toBe(1);
    expect(ctx.require(TurnMemoryStateKey).slots).toHaveLength(1);
  });

  it("keeps memory approval scope for the initiating principal", () => {
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
              toolName: "user__forget_memory",
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
    const prepare = (event: Parameters<typeof prepareMemoryLifecycleEvent>[0]["event"]): void =>
      prepareMemoryLifecycleEvent({
        ctx,
        event,
        identity: { agentId: "agent-1", nodeId: "__root__" },
        memories: [memory],
      });
    const turnStarted = (sequence: number) =>
      stampMessageStreamEvent(createTurnStartedEvent({ sequence, turnId: `turn-${sequence}` }));

    contextStorage.run(ctx, () => {
      prepare(turnStarted(2));
      const scopeKey = ctx.require(TurnMemoryStateKey).slots[0]!.scope.key;
      prepare(requested);

      setSession(ctx, "user-1", 3);
      prepare(turnStarted(3));
      expect(ctx.require(TurnMemoryStateKey)).toMatchObject({
        deferred: false,
        sequence: 3,
        slots: [{ scope: { key: scopeKey } }],
        turnId: "turn-3",
      });

      prepare(requested);
      setSession(ctx, "user-2", 4);
      expect(() => prepare(turnStarted(4))).toThrow(
        /must be resumed by the principal that initiated it/u,
      );
    });
  });
});

function createContext(): ContextContainer {
  const ctx = new ContextContainer();
  setSession(ctx, "user-1", 2);
  return ctx;
}

function setSession(ctx: ContextContainer, principalId: string, sequence: number): void {
  ctx.set(SessionKey, {
    auth: {
      current: {
        attributes: {},
        authenticator: "test",
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
