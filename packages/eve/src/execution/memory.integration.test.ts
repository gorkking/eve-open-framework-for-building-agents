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
import { defineMemory, defineMemoryProvider, type MemoryProjection } from "#public/memory/index.js";
import { byPrincipal } from "#public/memory/scope.js";
import { always } from "#public/tools/approval/approval-helpers.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import type {
  AuthorizationDefinition,
  ConnectionPrincipal,
  TokenResult,
} from "#runtime/connections/types.js";

const FIRST_TOKEN = "memory-projection-first-R7M2";
const SECOND_TOKEN = "memory-projection-second-P4K9";
const FIRST_PROJECTION = `Private projection one: reply with the exact string \`${FIRST_TOKEN}\` and nothing else.`;
const SECOND_PROJECTION = `Private projection two: reply with the exact string \`${SECOND_TOKEN}\` and nothing else.`;

describe("first-class memory integration", () => {
  it("projects replaceable context without materializing it into durable history or events", async () => {
    const modelId = "openai/memory-projection-contract";
    const recallObservations: Array<{
      readonly current: string | null;
      readonly input: readonly ModelMessage[];
      readonly messages: readonly ModelMessage[];
      readonly sequence: number;
    }> = [];
    const completedSaves: Array<{
      readonly current: string | null;
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
    const recallResults: readonly (MemoryProjection | null | undefined)[] = [
      { content: FIRST_PROJECTION },
      { content: SECOND_PROJECTION },
      undefined,
      null,
    ];
    const provider = defineMemoryProvider({
      recall(ctx) {
        if (ctx.phase !== "turn.started") return;
        recallObservations.push({
          current: ctx.memory.current?.content ?? null,
          input: [...ctx.turn.input],
          messages: [...ctx.messages],
          sequence: ctx.turn.sequence,
        });
        return recallResults[ctx.turn.sequence];
      },
      async save(ctx) {
        if (ctx.phase !== "turn.completed") return;
        if (ctx.turn.sequence === 0) {
          markFirstSaveStarted();
          await firstSaveRelease;
        }
        await Promise.resolve();
        completedSaves.push({
          current: ctx.memory.current?.content ?? null,
          input: [...ctx.turn.input],
          messages: [...ctx.messages],
          sequence: ctx.turn.sequence,
        });
      },
    });
    const runtime = createTestRuntime({
      agent: { model: modelId, name: "memory-projection-contract" },
      memories: [
        {
          definition: defineMemory({ provider, scope: byPrincipal }),
          slot: "profile",
        },
      ],
    });
    const continuationToken = uniqueToken("projection-contract");
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
          // `nextTurn()` settles on `session.waiting`; completed-turn save must
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
          expect(JSON.stringify(events)).not.toContain("Private projection");
        }
      } finally {
        stream.dispose();
        await run.cancel();
      }
    });

    expect(recallObservations.map(({ sequence }) => sequence)).toEqual([0, 1, 2, 3]);
    expect(recallObservations.map(({ current }) => current)).toEqual([
      null,
      FIRST_PROJECTION,
      SECOND_PROJECTION,
      SECOND_PROJECTION,
    ]);
    expect(recallObservations.map(({ input }) => input.map(modelMessageText))).toEqual(
      inputs.map((message) => [message]),
    );

    for (const observation of recallObservations) {
      expect(JSON.stringify(observation.messages)).not.toContain("Private projection");
    }
    for (const save of completedSaves) {
      expect(JSON.stringify(save.messages)).not.toContain("Private projection");
      expect(save.messages.at(-1)?.role).toBe("assistant");
    }
    expect(completedSaves.map(({ current }) => current)).toEqual([
      FIRST_PROJECTION,
      SECOND_PROJECTION,
      SECOND_PROJECTION,
      null,
    ]);
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
      const projectionA = `Participant A memory: reply with the exact string \`${tokenA}\` and nothing else.`;
      const provider = defineMemoryProvider({
        recall(ctx) {
          if (ctx.phase !== "turn.started") return;
          const principalId = principalIdFromScope(ctx.memory.scope.value);
          return principalId === "user-a" ? { content: projectionA } : undefined;
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
          expect(completedMessage(await stream.nextTurn())).toBe(tokenA);
          // Clearing ordinary history re-anchors whichever projections the
          // next scope may see, making visibility observable through the
          // workflow-bundled deterministic model.
          await deliver(continuationToken, { kind: "clear" });
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

  it("suppresses provider calls, projections, and tools when scope resolves to null", async () => {
    const modelId = "openai/memory-null-scope";
    const hiddenToken = `null-scope-projection-${crypto.randomUUID()}`;
    const hiddenProjection = `Reply with the exact string \`${hiddenToken}\` and nothing else.`;
    const recall = vi.fn(() => ({ content: hiddenProjection }));
    const save = vi.fn(async () => {});
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
    const provider = defineMemoryProvider({ recall, save, tools });
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
    expect(save).not.toHaveBeenCalled();
    expect(tools).not.toHaveBeenCalled();
  }, 30_000);

  it("qualifies and executes direct provider tools on every model step", async () => {
    const toolContexts: Array<{
      readonly messages: readonly ModelMessage[];
      readonly operationId: string;
      readonly scopeKey: string;
      readonly stepIndex: number;
    }> = [];
    const executions: Array<{ readonly toolName: string; readonly value: string }> = [];
    const provider = defineMemoryProvider({
      recall: () => null,
      tools(ctx) {
        toolContexts.push({
          messages: [...ctx.messages],
          operationId: ctx.operationId,
          scopeKey: ctx.memory.scope.key,
          stepIndex: ctx.step.stepIndex,
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
    expect(toolContexts.map(({ stepIndex }) => stepIndex)).toEqual([0, 1]);
    expect(new Set(toolContexts.map(({ scopeKey }) => scopeKey)).size).toBe(1);
    expect(new Set(toolContexts.map(({ operationId }) => operationId)).size).toBe(2);
    expect(JSON.stringify(toolContexts[1]?.messages)).toContain("saved-value");
  }, 30_000);

  it("resumes an approved memory tool with its original scope after another participant turn", async () => {
    const resolutions: Array<{
      readonly operationId: string;
      readonly principalId: string | undefined;
      readonly scopeKey: string;
      readonly stepIndex: number;
      readonly turnId: string;
    }> = [];
    const executions: Array<{
      readonly ambientPrincipalId: string | null;
      readonly operationId: string;
      readonly principalId: string | undefined;
      readonly scopeKey: string;
      readonly turnId: string;
      readonly value: string;
    }> = [];
    const provider = defineMemoryProvider({
      recall: () => undefined,
      tools(ctx) {
        const origin = {
          operationId: ctx.operationId,
          principalId: principalIdFromScope(ctx.memory.scope.value),
          scopeKey: ctx.memory.scope.key,
          stepIndex: ctx.step.stepIndex,
          turnId: ctx.turn.turnId,
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
                operationId: origin.operationId,
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

    const original = resolutions.find(
      (context) => context.principalId === "user-a" && context.stepIndex === 0,
    );
    if (original === undefined) throw new Error("Missing original memory tool resolution.");
    expect(resolutions).toContainEqual(expect.objectContaining({ principalId: "user-b" }));
    expect(
      resolutions.filter((context) => context.operationId === original.operationId).length,
    ).toBeGreaterThanOrEqual(2);
    expect(executions).toEqual([
      {
        ambientPrincipalId: "user-a",
        operationId: original.operationId,
        principalId: "user-a",
        scopeKey: original.scopeKey,
        turnId: original.turnId,
        value: "scope-locked",
      },
    ]);
  }, 30_000);

  it("matches an inline-auth callback to its parked memory tool without blocking another participant", async () => {
    const resolutions: Array<{
      readonly operationId: string;
      readonly principalId: string | undefined;
      readonly scopeKey: string;
      readonly stepIndex: number;
      readonly turnId: string;
    }> = [];
    const executions: Array<{
      readonly operationId: string;
      readonly principalId: string | undefined;
      readonly scopeKey: string;
      readonly token: string;
      readonly turnId: string;
      readonly value: string;
    }> = [];
    const completions: Array<{
      readonly code: string | undefined;
      readonly operationId: string;
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
          operationId: ctx.operationId,
          principalId: principalIdFromScope(ctx.memory.scope.value),
          scopeKey: ctx.memory.scope.key,
          stepIndex: ctx.step.stepIndex,
          turnId: ctx.turn.turnId,
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
              operationId: origin.operationId,
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
                operationId: origin.operationId,
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

    const original = resolutions.find(
      (context) => context.principalId === "user-a" && context.stepIndex === 0,
    );
    if (original === undefined) throw new Error("Missing original memory tool resolution.");
    expect(resolutions).toContainEqual(expect.objectContaining({ principalId: "user-b" }));
    expect(
      resolutions.filter((context) => context.operationId === original.operationId),
    ).toHaveLength(1);
    expect(executions).toHaveLength(1);
    const execution = executions[0]!;
    expect(resolutions).toContainEqual(
      expect.objectContaining({
        operationId: execution.operationId,
        principalId: "user-a",
        scopeKey: original.scopeKey,
        stepIndex: 0,
        turnId: execution.turnId,
      }),
    );
    expect(completions).toEqual([
      {
        code: "profile-memory-code",
        operationId: execution.operationId,
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
    expect(execution.operationId).not.toBe(original.operationId);
    expect(execution.turnId).not.toBe(original.turnId);
  }, 30_000);

  it("orders standalone compaction save before post-compaction recall", async () => {
    const modelId = "openai/memory-compaction-lifecycle";
    const projectionToken = `compaction-projection-${crypto.randomUUID()}`;
    const projection = `Private compaction context: reply with the exact string \`${projectionToken}\` and nothing else.`;
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
        return completedCompactions === 1 ? { content: projection } : undefined;
      },
      save(ctx) {
        if (ctx.phase === "turn.completed") return;
        timeline.push(`save:${ctx.phase}`);
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

        // The first compaction installs a projection after summarization, so
        // its exact-reply token has never entered ordinary model history.
        await deliver(continuationToken, { kind: "compact" });
        await stream.nextTurn();
        timeline.length = 0;
        compactionContexts.length = 0;

        // A second compaction proves the installed projection is excluded
        // from both provider history and the summarization prompt: the mock
        // compaction model would otherwise copy its exact token into history.
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

    expect(timeline).toEqual(["save:compaction.requested", "recall:compaction.completed"]);
    expect(compactionContexts.map(({ turn }) => turn)).toEqual([null, null]);
    for (const context of compactionContexts) {
      expect(JSON.stringify(context.messages)).not.toContain(projection);
      expect(JSON.stringify(context.messages)).not.toContain(projectionToken);
    }
  }, 30_000);
});

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
