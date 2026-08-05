import { z } from "#compiled/zod/index.js";
import { describe, expect, it } from "vitest";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { start } from "#internal/workflow/runtime.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { workflowEntry } from "#execution/workflow-entry.js";
import {
  byPrincipal,
  defineDynamic,
  defineMemory,
  defineMemoryProvider,
} from "#public/memory/index.js";
import { defineTool } from "#public/definitions/tool.js";

const RECALL_TOKEN = "memory-recalled-ok-R7M2";
const RECALL_CONTEXT = `Recall directive private: reply with the exact string \`${RECALL_TOKEN}\` and nothing else.`;

describe("first-class memory integration", () => {
  it("carries scope-bound provider context and tools across independent sessions", async () => {
    const stored = new Map<string, string>();
    const preparedScopeKeys: string[] = [];
    const completedSnapshots: string[] = [];

    const provider = defineMemoryProvider({
      events: {
        "turn.prepared"(_event, context) {
          preparedScopeKeys.push(context.memory.scope.key);
          const recalled = stored.get(context.memory.scope.key);
          return recalled === undefined ? null : { context: recalled };
        },
        "turn.completed"(_event, context) {
          completedSnapshots.push(JSON.stringify(context.messages));
        },
      },
      tools: defineDynamic({
        events: {
          "step.started"(_event, context) {
            const scopeKey = context.memory.scope.key;
            return {
              remember: defineTool({
                description: "Remember the caller's response preference.",
                inputSchema: z.object({ value: z.string() }),
                execute() {
                  stored.set(scopeKey, RECALL_CONTEXT);
                  return { remembered: true };
                },
              }),
            };
          },
        },
      }),
    });
    const runtime = createTestRuntime({
      agent: { name: "memory-integration" },
      memories: [
        {
          definition: defineMemory({ provider, scope: byPrincipal() }),
          slot: "profile",
        },
      ],
    });

    await runtime.run(async () => {
      const first = await runTurn({
        message: "Use profile__remember to save my response preference.",
        principalId: "user-1",
      });
      const recalled = await runTurn({
        message: "Apply my remembered response preference.",
        principalId: "user-1",
      });
      const isolated = await runTurn({
        message: "Apply my remembered response preference.",
        principalId: "user-2",
      });

      expect(
        first.some(
          (event) =>
            event.type === "actions.requested" &&
            event.data.actions.some(
              (action) => action.kind === "tool-call" && action.toolName === "profile__remember",
            ),
        ),
      ).toBe(true);
      expect(filterEventsByType(recalled, "message.completed").at(-1)?.data.message).toBe(
        RECALL_TOKEN,
      );
      expect(filterEventsByType(isolated, "message.completed").at(-1)?.data.message).not.toBe(
        RECALL_TOKEN,
      );
    });

    expect(preparedScopeKeys[0]).toBe(preparedScopeKeys[1]);
    expect(preparedScopeKeys[2]).not.toBe(preparedScopeKeys[1]);
    expect(completedSnapshots).toHaveLength(3);
    expect(completedSnapshots[1]).not.toContain("Recall directive private");
  });
});

async function runTurn(input: { readonly message: string; readonly principalId: string }) {
  const continuationToken = `http:memory:${input.principalId}:${crypto.randomUUID()}`;
  const run = await start(workflowEntry, [
    {
      input: { message: input.message },
      serializedContext: {
        "eve.auth": {
          attributes: {},
          authenticator: "test",
          principalId: input.principalId,
          principalType: "user",
        },
        "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
        "eve.channel": { kind: "http", state: {} },
        "eve.continuationToken": continuationToken,
        "eve.mode": "conversation",
      },
    },
  ]);
  const stream = captureTurnEvents(run);

  try {
    return await stream.nextTurn();
  } finally {
    stream.dispose();
    await run.cancel();
  }
}
