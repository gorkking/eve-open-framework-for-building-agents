import type { ModelMessage } from "ai";
import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext, SessionCommand } from "#channel/types.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import {
  captureTurnEvents,
  containsEventSequence,
  filterEventsByType,
} from "#internal/testing/events.js";
import { resumeHook, start } from "#internal/workflow/runtime.js";
import { ConnectionAuthorizationRequiredError } from "#public/connections/errors.js";
import { defineTool } from "#public/definitions/tool.js";
import {
  defineMemory,
  defineMemoryProvider,
  getMemoryMessageAttribution,
  type MemoryRecallResult,
} from "#public/memory/index.js";
import { byPrincipal } from "#public/memory/scope.js";
import { always } from "#public/tools/approval/approval-helpers.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type {
  AuthorizationDefinition,
  ConnectionPrincipal,
  TokenResult,
} from "#runtime/connections/types.js";

const FIRST_TOKEN = "memory-recall-first-R7M2";
const SECOND_TOKEN = "memory-recall-second-P4K9";
const FIRST_RECALL = `Private recall one: reply with the exact string \`${FIRST_TOKEN}\` and nothing else.`;
const SECOND_RECALL = `Private recall two: reply with the exact string \`${SECOND_TOKEN}\` and nothing else.`;

describe("first-class memory integration", () => {
  it("appends recalled user messages to durable history without emitting received events", async () => {
    const modelId = "openai/memory-recall-contract";
    const recallObservations: Array<{
      readonly input: readonly ModelMessage[];
      readonly messages: readonly ModelMessage[];
      readonly sequence: number;
    }> = [];
    const completedSaves: Array<{
      readonly input: readonly ModelMessage[];
      readonly messages: readonly ModelMessage[];
      readonly sequence: number;
    }> = [];
    let markFirstSaveStarted = () => {};
    const firstSaveStarted = new Promise<void>((resolve) => {
      markFirstSaveStarted = resolve;
    });
    let releaseFirstSave = () => {};
    const firstSaveRelease = new Promise<void>((resolve) => {
      releaseFirstSave = resolve;
    });
    const recallResults: readonly MemoryRecallResult[] = [
      { content: FIRST_RECALL, role: "user" },
      { content: SECOND_RECALL, role: "user" },
      undefined,
      null,
    ];
    const provider = defineMemoryProvider({
      recall(ctx) {
        if (ctx.phase !== "turn.started") return;
        recallObservations.push({
          input: [...ctx.turn.input],
          messages: [...ctx.messages],
          sequence: ctx.turn.sequence,
        });
        return recallResults[ctx.turn.sequence];
      },
      async capture(ctx) {
        if (ctx.phase !== "turn.completed") return;
        if (ctx.turn.sequence === 0) {
          markFirstSaveStarted();
          await firstSaveRelease;
        }
        await Promise.resolve();
        completedSaves.push({
          input: [...ctx.turn.input],
          messages: [...ctx.messages],
          sequence: ctx.turn.sequence,
        });
      },
    });
    const runtime = createTestRuntime({
      agent: { model: modelId, name: "memory-recall-contract" },
      memories: [
        {
          definition: defineMemory({ provider, scope: byPrincipal }),
          slot: "profile",
        },
      ],
    });
    const continuationToken = uniqueToken("recall-contract");
    const inputs = ["first turn", "second turn", "third turn", "fourth turn"];

    await runtime.run(async () => {
      const { run, stream } = await startConversation({
        continuationToken,
        message: inputs[0]!,
        modelPrincipalId: "user-a",
      });

      try {
        let firstTurnSettled = false;
        const firstTurnPromise = stream.nextTurn().then((events) => {
          firstTurnSettled = true;
          return events;
        });
        await firstSaveStarted;
        await Promise.resolve();
        try {
          expect(firstTurnSettled).toBe(false);
        } finally {
          releaseFirstSave();
        }

        const turns = [await firstTurnPromise];
        expect(completedSaves).toHaveLength(1);

        for (let index = 1; index < inputs.length; index += 1) {
          await deliver(continuationToken, {
            auth: principal("user-a"),
            kind: "send",
            payload: { message: inputs[index]! },
          });
          turns.push(await stream.nextTurn());
          // `nextTurn()` settles on `session.waiting`; completed-turn capture must
          // already be awaited before that ready boundary is observable.
          expect(completedSaves).toHaveLength(index + 1);
        }

        expect(turns.map((events) => completedMessage(events))).toEqual([
          FIRST_TOKEN,
          expect.any(String),
          expect.any(String),
          expect.any(String),
        ]);
        expect(turns.map((events) => filterEventsByType(events, "message.received"))).toEqual(
          inputs.map((message) => [
            expect.objectContaining({ data: expect.objectContaining({ message }) }),
          ]),
        );
        for (const events of turns) {
          expect(JSON.stringify(events)).not.toContain("Private recall");
        }
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });

    expect(recallObservations.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3]);
    expect(recallObservations.map(({ input }) => input.map(modelMessageText))).toEqual(
      inputs.map((message) => [message]),
    );
    expect(recalledContents(recallObservations[0]!.messages)).toEqual([]);
    expect(recalledContents(recallObservations[1]!.messages)).toEqual([FIRST_RECALL]);
    expect(recalledContents(recallObservations[2]!.messages)).toEqual([
      FIRST_RECALL,
      SECOND_RECALL,
    ]);
    expect(recalledContents(recallObservations[3]!.messages)).toEqual([
      FIRST_RECALL,
      SECOND_RECALL,
    ]);
    expect(completedSaves.map(({ messages }) => recalledContents(messages))).toEqual([
      [FIRST_RECALL],
      [FIRST_RECALL, SECOND_RECALL],
      [FIRST_RECALL, SECOND_RECALL],
      [FIRST_RECALL, SECOND_RECALL],
    ]);
    expect(completedSaves.every(({ messages }) => messages.at(-1)?.role === "assistant")).toBe(
      true,
    );
    expect(completedSaves.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3]);
    expect(completedSaves.map(({ input }) => input.map(modelMessageText))).toEqual(
      inputs.map((message) => [message]),
    );
  }, 30_000);

  it.each([
    ["scope default", undefined, false],
    ["session visibility", "session" as const, true],
  ])(
    "applies %s when a second participant enters one session",
    async (_label, visibility, keepA) => {
      const modelId = `openai/memory-visibility-${visibility ?? "default"}`;
      const tokenA = `scope-a-${crypto.randomUUID()}`;
      const recallA = `Participant A memory: reply with the exact string \`${tokenA}\` and nothing else.`;
      const provider = defineMemoryProvider({
        recall(ctx) {
          if (ctx.phase !== "compaction.completed") return;
          const principalId = principalIdFromScope(ctx.memory.scope.value);
          return principalId === "user-a" ? { content: recallA, role: "user" } : undefined;
        },
      });
      const definition =
        visibility === undefined
          ? defineMemory({ provider, scope: byPrincipal })
          : defineMemory({ provider, scope: byPrincipal, visibility });
      const runtime = createTestRuntime({
        agent: { model: modelId, name: `memory-visibility-${visibility ?? "default"}` },
        memories: [{ definition, slot: "profile" }],
      });
      const continuationToken = uniqueToken(`visibility-${visibility ?? "default"}`);
      let participantBReply: string | null | undefined;

      await runtime.run(async () => {
        const { run, stream } = await startConversation({
          continuationToken,
          message: "participant a turn",
          modelPrincipalId: "user-a",
        });

        try {
          await stream.nextTurn();
          await deliver(continuationToken, { kind: "compact" });
          await stream.nextTurn();
          await deliver(continuationToken, {
            auth: principal("user-b"),
            kind: "send",
            payload: { message: "participant b turn" },
          });
          participantBReply = completedMessage(await stream.nextTurn());
        } finally {
          stream.dispose();
          await run.cancel();
        }
      });

      if (keepA) {
        expect(participantBReply).toBe(tokenA);
      } else {
        expect(participantBReply).not.toBe(tokenA);
      }
    },
    30_000,
  );

  it("suppresses provider calls, recall, and tools when scope resolves to null", async () => {
    const modelId = "openai/memory-null-scope";
    const hiddenToken = `null-scope-recall-${crypto.randomUUID()}`;
    const hiddenProjection = `Reply with the exact string \`${hiddenToken}\` and nothing else.`;
    const recall = vi.fn(() => ({ content: hiddenProjection, role: "user" as const }));
    const capture = vi.fn(async () => {});
    const tools = vi.fn(() => ({
      hidden: defineTool<Record<string, unknown>, unknown>({
        description: "This tool must never be exposed.",
        inputSchema: {
          additionalProperties: false,
          properties: {},
          type: "object",
        },
        execute: () => ({ exposed: true }),
      }),
    }));
    const provider = defineMemoryProvider({ capture, recall, tools });
    const runtime = createTestRuntime({
      agent: { model: modelId, name: "memory-null-scope" },
      memories: [
        {
          definition: defineMemory({ provider, scope: () => null }),
          slot: "profile",
        },
      ],
    });

    await runtime.run(async () => {
      const { run, stream } = await startConversation({
        continuationToken: uniqueToken("null-scope"),
        message: "try profile__hidden",
        modelPrincipalId: "user-a",
      });

      try {
        const events = await stream.nextTurn();
        expect(filterEventsByType(events, "actions.requested")).toHaveLength(0);
        expect(completedMessage(events)).not.toBe(hiddenToken);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });

    expect(recall).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
  }, 30_000);

  it("resolves async provider tools once and replays them across model steps", async () => {
    const toolContexts: Array<{
      readonly messages: readonly ModelMessage[];
      readonly scopeKey: string;
      readonly sessionId: string;
      readonly turnId: string;
    }> = [];
    const executions: Array<{ readonly toolName: string; readonly value: string }> = [];
    const provider = defineMemoryProvider({
      recall: () => null,
      async tools(ctx) {
        await Promise.resolve();
        toolContexts.push({
          messages: [...ctx.messages],
          scopeKey: ctx.memory.scope.key,
          sessionId: ctx.session.id,
          turnId: ctx.turn.id,
        });
        return {
          remember: defineTool<Record<string, unknown>, unknown>({
            description: "Remember one value for this integration test.",
            inputSchema: {
              additionalProperties: false,
              properties: { value: { type: "string" } },
              required: ["value"],
              type: "object",
            },
            execute(input, toolContext) {
              const value = input.value;
              if (typeof value !== "string") throw new TypeError("Expected a string value.");
              executions.push({ toolName: toolContext.toolName, value });
              return { remembered: value };
            },
          }),
        };
      },
    });
    const runtime = createTestRuntime({
      agent: { model: "openai/memory-direct-tools", name: "memory-direct-tools" },
      memories: [
        {
          definition: defineMemory({ provider, scope: byPrincipal }),
          slot: "profile",
        },
      ],
    });

    await runtime.run(async () => {
      const { run, stream } = await startConversation({
        continuationToken: uniqueToken("direct-tools"),
        message: 'Use profile__remember with value: "saved-value".',
        modelPrincipalId: "user-a",
      });

      try {
        const events = await stream.nextTurn();
        expect(
          filterEventsByType(events, "actions.requested").flatMap((event) =>
            event.data.actions.flatMap((action) =>
              action.kind === "tool-call" ? [action.toolName] : [],
            ),
          ),
        ).toContain("profile__remember");
        expect(JSON.stringify(filterEventsByType(events, "action.result"))).toContain(
          "saved-value",
        );
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });

    expect(executions).toEqual([{ toolName: "profile__remember", value: "saved-value" }]);
    expect(toolContexts).toHaveLength(1);
    expect(toolContexts[0]).toMatchObject({ sessionId: expect.any(String), turnId: "turn_0" });
    expect(toolContexts[0]?.scopeKey).toMatch(/^mem_/u);
    expect(JSON.stringify(toolContexts[0]?.messages)).toContain("profile__remember");
  }, 30_000);

  it("resumes an approved memory tool with its original scope after another participant turn", async () => {
    const resolutions: Array<{
      readonly principalId: string | undefined;
      readonly scopeKey: string;
      readonly turnId: string;
    }> = [];
    const executions: Array<{
      readonly ambientPrincipalId: string | null;
      readonly principalId: string | undefined;
      readonly scopeKey: string;
      readonly turnId: string;
      readonly value: string;
    }> = [];
    const provider = defineMemoryProvider({
      recall: () => undefined,
      tools(ctx) {
        const origin = {
          principalId: principalIdFromScope(ctx.memory.scope.value),
          scopeKey: ctx.memory.scope.key,
          turnId: ctx.turn.id,
        };
        resolutions.push(origin);
        return {
          guarded: defineTool<Record<string, unknown>, unknown>({
            approval: always<Record<string, unknown>>(),
            description: "Store one value after approval.",
            inputSchema: {
              additionalProperties: false,
              properties: { value: { type: "string" } },
              required: ["value"],
              type: "object",
            },
            execute(input, toolContext) {
              const value = input.value;
              if (typeof value !== "string") throw new TypeError("Expected a string value.");
              executions.push({
                ambientPrincipalId: toolContext.session.auth.current?.principalId ?? null,
                principalId: origin.principalId,
                scopeKey: origin.scopeKey,
                turnId: origin.turnId,
                value,
              });
              return { stored: value };
            },
          }),
        };
      },
    });
    const runtime = createTestRuntime({
      agent: { model: "openai/memory-approval-scope", name: "memory-approval-scope" },
      memories: [
        {
          definition: defineMemory({ provider, scope: byPrincipal }),
          slot: "profile",
        },
      ],
    });
    const continuationToken = uniqueToken("approval-scope");

    await runtime.run(async () => {
      const { run, stream } = await startConversation({
        continuationToken,
        message: 'Use profile__guarded with value: "scope-locked".',
        modelPrincipalId: "user-a",
      });

      try {
        const approvalTurn = await stream.nextTurn();
        const request = filterEventsByType(approvalTurn, "input.requested")
          .flatMap((event) => event.data.requests)
          .find((candidate) => candidate.kind === "tool-approval");
        expect(request).toMatchObject({
          action: { toolName: "profile__guarded" },
          kind: "tool-approval",
        });
        if (request === undefined) throw new Error("Missing memory tool approval request.");
        expect(executions).toHaveLength(0);

        await deliver(continuationToken, {
          auth: principal("user-b"),
          kind: "send",
          payload: { message: "Participant B can continue while approval stays open." },
        });
        const interveningTurn = await stream.nextTurn();
        expect(completedMessage(interveningTurn)).toContain(
          "Participant B can continue while approval stays open.",
        );
        expect(filterEventsByType(interveningTurn, "action.result")).toHaveLength(0);
        expect(executions).toHaveLength(0);

        await deliver(continuationToken, {
          auth: principal("user-a"),
          kind: "send",
          payload: {
            inputResponses: [{ optionId: "approve", requestId: request.requestId }],
          },
        });
        const resumedTurn = await stream.nextTurn();
        expect(JSON.stringify(filterEventsByType(resumedTurn, "action.result"))).toContain(
          "scope-locked",
        );
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });

    const original = resolutions.find((context) => context.principalId === "user-a");
    if (original === undefined) throw new Error("Missing original memory tool resolution.");
    expect(resolutions).toContainEqual(expect.objectContaining({ principalId: "user-b" }));
    expect(resolutions.filter((context) => context.turnId === original.turnId)).toHaveLength(1);
    expect(executions).toEqual([
      {
        ambientPrincipalId: "user-a",
        principalId: "user-a",
        scopeKey: original.scopeKey,
        turnId: original.turnId,
        value: "scope-locked",
      },
    ]);
  }, 30_000);

  it("matches an inline-auth callback to its parked memory tool without blocking another participant", async () => {
    const resolutions: Array<{
      readonly principalId: string | undefined;
      readonly scopeKey: string;
      readonly turnId: string;
    }> = [];
    const executions: Array<{
      readonly principalId: string | undefined;
      readonly scopeKey: string;
      readonly token: string;
      readonly turnId: string;
      readonly value: string;
    }> = [];
    const completions: Array<{
      readonly code: string | undefined;
      readonly principal: ConnectionPrincipal;
      readonly principalId: string | undefined;
      readonly resume: { readonly nonce: string } | undefined;
      readonly scopeKey: string;
      readonly turnId: string;
    }> = [];
    const provider = defineMemoryProvider({
      recall: () => undefined,
      tools(ctx) {
        const origin = {
          principalId: principalIdFromScope(ctx.memory.scope.value),
          scopeKey: ctx.memory.scope.key,
          turnId: ctx.turn.id,
        };
        resolutions.push(origin);
        const inlineAuth: AuthorizationDefinition<{ nonce: string }> = {
          principalType: "user",
          async getToken(): Promise<TokenResult> {
            throw new ConnectionAuthorizationRequiredError("profile-memory-auth");
          },
          async startAuthorization({ callbackUrl }) {
            return {
              challenge: {
                displayName: "Profile memory",
                instructions: "Sign in to update profile memory.",
                url: `https://idp.example/authorize?callback=${encodeURIComponent(callbackUrl)}`,
              },
              resume: { nonce: "profile-memory-nonce" },
            };
          },
          async completeAuthorization({ callback, principal: completedPrincipal, resume }) {
            completions.push({
              code: callback.params.code,
              principal: completedPrincipal,
              principalId: origin.principalId,
              resume,
              scopeKey: origin.scopeKey,
              turnId: origin.turnId,
            });
            return { token: "profile-memory-token" };
          },
        };
        return {
          protected: defineTool<Record<string, unknown>, unknown>({
            description: "Store one value using authenticated profile memory.",
            inputSchema: {
              additionalProperties: false,
              properties: { value: { type: "string" } },
              required: ["value"],
              type: "object",
            },
            async execute(input, toolContext) {
              const value = input.value;
              if (typeof value !== "string") throw new TypeError("Expected a string value.");
              const token = await toolContext.getToken(inlineAuth, {
                authKey: "profile-memory-auth",
                displayName: "Profile memory",
              });
              executions.push({
                principalId: origin.principalId,
                scopeKey: origin.scopeKey,
                token: token.token,
                turnId: origin.turnId,
                value,
              });
              return { stored: value, token: token.token };
            },
          }),
        };
      },
    });
    const runtime = createTestRuntime({
      agent: { model: "openai/memory-inline-auth", name: "memory-inline-auth" },
      memories: [
        {
          definition: defineMemory({ provider, scope: byPrincipal }),
          slot: "profile",
        },
      ],
    });
    const continuationToken = uniqueToken("inline-auth");

    await runtime.run(async () => {
      const { run, stream } = await startConversation({
        continuationToken,
        message: 'Use profile__protected with value: "auth-locked".',
        modelPrincipalId: "user-a",
      });

      try {
        const authorizationTurn = await stream.nextTurn();
        const challenge = authorizationChallenge(authorizationTurn);
        expect(challenge.name).toBe("profile-memory-auth");
        expect(filterEventsByType(authorizationTurn, "action.result")).toHaveLength(0);
        expect(executions).toHaveLength(0);

        await deliver(continuationToken, {
          auth: principal("user-b"),
          kind: "send",
          payload: { message: "Participant B remains unblocked by participant A's sign-in." },
        });
        const interveningTurn = await stream.nextTurn();
        expect(completedMessage(interveningTurn)).toContain(
          "Participant B remains unblocked by participant A's sign-in.",
        );
        expect(filterEventsByType(interveningTurn, "authorization.completed")).toHaveLength(0);
        expect(executions).toHaveLength(0);

        await resumeHook(`${run.runId}:auth`, {
          kind: "deliver",
          payloads: [
            {
              authorizationCallback: {
                attemptId: challenge.attemptId,
                callback: { method: "GET", params: { code: "profile-memory-code" } },
                connectionName: challenge.name,
              },
            },
          ],
        });
        const resumedTurn = await stream.nextTurn();
        expect(filterEventsByType(resumedTurn, "authorization.completed")).toMatchObject([
          { data: { name: challenge.name, outcome: "authorized" } },
        ]);
        expect(filterEventsByType(resumedTurn, "action.result")).toHaveLength(0);
        expect(executions).toHaveLength(0);

        await deliver(continuationToken, {
          auth: principal("user-b"),
          kind: "send",
          payload: { message: "Participant B still cannot consume participant A's callback." },
        });
        const postCallbackParticipantTurn = await stream.nextTurn();
        expect(completedMessage(postCallbackParticipantTurn)).toContain(
          "Participant B still cannot consume participant A's callback.",
        );
        expect(completions).toHaveLength(0);
        expect(executions).toHaveLength(0);

        await deliver(continuationToken, {
          auth: principal("user-a"),
          kind: "send",
          payload: { message: 'Use profile__protected with value: "after-auth".' },
        });
        const authenticatedToolTurn = await stream.nextTurn();
        expect(
          JSON.stringify(filterEventsByType(authenticatedToolTurn, "action.result")),
        ).toContain("after-auth");
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });

    const original = resolutions.find((context) => context.principalId === "user-a");
    if (original === undefined) throw new Error("Missing original memory tool resolution.");
    expect(resolutions).toContainEqual(expect.objectContaining({ principalId: "user-b" }));
    expect(resolutions.filter((context) => context.turnId === original.turnId)).toHaveLength(1);
    expect(executions).toHaveLength(1);
    const execution = executions[0]!;
    expect(resolutions).toContainEqual(
      expect.objectContaining({
        principalId: "user-a",
        scopeKey: original.scopeKey,
        turnId: execution.turnId,
      }),
    );
    expect(completions).toEqual([
      {
        code: "profile-memory-code",
        principal: expect.objectContaining({ id: "user-a", type: "user" }),
        principalId: "user-a",
        resume: { nonce: "profile-memory-nonce" },
        scopeKey: execution.scopeKey,
        turnId: execution.turnId,
      },
    ]);
    expect(execution).toMatchObject({
      principalId: "user-a",
      scopeKey: original.scopeKey,
      token: "profile-memory-token",
      value: "after-auth",
    });
    expect(execution.turnId).not.toBe(original.turnId);
  }, 30_000);

  it("orders standalone compaction capture before post-compaction recall", async () => {
    const modelId = "openai/memory-compaction-lifecycle";
    const recallToken = `compaction-recall-${crypto.randomUUID()}`;
    const recalled = `Private compaction context: reply with the exact string \`${recallToken}\` and nothing else.`;
    const timeline: string[] = [];
    let completedCompactions = 0;
    const compactionContexts: Array<{
      readonly messages: readonly ModelMessage[];
      readonly phase: "compaction.completed" | "compaction.requested";
      readonly turn: unknown;
    }> = [];
    const provider = defineMemoryProvider({
      recall(ctx) {
        if (ctx.phase === "turn.started") return;
        timeline.push(`recall:${ctx.phase}`);
        compactionContexts.push({ messages: [...ctx.messages], phase: ctx.phase, turn: ctx.turn });
        completedCompactions += 1;
        return completedCompactions === 1 ? { content: recalled, role: "user" } : undefined;
      },
      capture(ctx) {
        if (ctx.phase === "turn.completed") return;
        timeline.push(`capture:${ctx.phase}`);
        compactionContexts.push({ messages: [...ctx.messages], phase: ctx.phase, turn: ctx.turn });
      },
    });
    const runtime = createTestRuntime({
      agent: { model: modelId, name: "memory-compaction-lifecycle" },
      memories: [
        {
          definition: defineMemory({ provider, scope: byPrincipal }),
          slot: "profile",
        },
      ],
    });
    const continuationToken = uniqueToken("compaction-lifecycle");

    await runtime.run(async () => {
      const { run, stream } = await startConversation({
        continuationToken,
        message: "seed ordinary history",
        modelPrincipalId: "user-a",
      });

      try {
        await stream.nextTurn();

        // The first compaction appends recall after the rewritten checkpoint.
        await deliver(continuationToken, { kind: "compact" });
        await stream.nextTurn();
        timeline.length = 0;
        compactionContexts.length = 0;

        // A second compaction must expose that durable recall to both provider
        // boundaries and the compaction prompt.
        await deliver(continuationToken, { kind: "compact" });
        const events = await stream.nextTurn();

        expect(
          containsEventSequence(events, [
            "compaction.requested",
            "compaction.completed",
            "session.waiting",
          ]),
        ).toBe(true);
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });

    expect(timeline).toEqual(["capture:compaction.requested", "recall:compaction.completed"]);
    expect(compactionContexts.map(({ turn }) => turn)).toEqual([null, null]);
    expect(recalledContents(compactionContexts[0]!.messages)).toEqual([recalled]);
    expect(JSON.stringify(compactionContexts[1]!.messages)).toContain(recallToken);
  }, 30_000);
});

function recalledContents(messages: readonly ModelMessage[]): string[] {
  return messages.flatMap((message) =>
    getMemoryMessageAttribution(message) === null || typeof message.content !== "string"
      ? []
      : [message.content],
  );
}

function authorizationChallenge(events: Parameters<typeof filterEventsByType>[0]): {
  readonly attemptId: string;
  readonly name: string;
} {
  const required = filterEventsByType(events, "authorization.required")[0];
  const webhookUrl = required?.data.webhookUrl;
  if (required === undefined || webhookUrl === undefined) {
    throw new Error("Missing memory tool authorization challenge.");
  }
  const segments = new URL(webhookUrl).pathname.split("/");
  const callbackIndex = segments.lastIndexOf("callback");
  const attemptId = segments[callbackIndex + 1];
  if (callbackIndex === -1 || attemptId === undefined) {
    throw new Error("Memory tool authorization callback is missing its attempt ID.");
  }
  return { attemptId: decodeURIComponent(attemptId), name: required.data.name };
}

function modelMessageText(message: ModelMessage): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

function completedMessage(
  events: Parameters<typeof filterEventsByType>[0],
): string | null | undefined {
  return filterEventsByType(events, "message.completed").at(-1)?.data.message;
}

async function startConversation(input: {
  readonly continuationToken: string;
  readonly message: string;
  readonly modelPrincipalId: string;
}) {
  const run = await start(workflowEntry, [
    {
      input: { message: input.message },
      serializedContext: {
        "eve.auth": principal(input.modelPrincipalId),
        "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
        "eve.channel": { kind: "http", state: {} },
        "eve.continuationToken": input.continuationToken,
        "eve.mode": "conversation",
      },
    },
  ]);
  return { run, stream: captureTurnEvents(run) };
}

function principal(principalId: string): SessionAuthContext {
  return {
    attributes: {},
    authenticator: "test",
    principalId,
    principalType: "user",
  };
}

function principalIdFromScope(value: string): string | undefined {
  const identity: unknown = JSON.parse(value);
  if (!Array.isArray(identity)) return undefined;
  const principalId = identity[3];
  return typeof principalId === "string" ? principalId : undefined;
}

async function deliver(
  continuationToken: string,
  command: SessionCommand,
  timeout = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (true) {
    try {
      await resumeHook(continuationToken, command);
      return;
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function uniqueToken(label: string): string {
  return `http:memory:${label}:${crypto.randomUUID()}`;
}
