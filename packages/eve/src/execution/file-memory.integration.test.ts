import { describe, expect, it } from "vitest";

import { workflowEntry } from "#execution/workflow-entry.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { captureTurnEvents, filterEventsByType } from "#internal/testing/events.js";
import { start } from "#internal/workflow/runtime.js";
import { defineMemory } from "#public/memory/index.js";
import { inMemory, fileMemory } from "#public/memory/file/index.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";

describe("file memory integration", () => {
  it("saves, recalls, and isolates indexed memories across scopes", async () => {
    const backend = inMemory();
    const runtime = createTestRuntime({
      agent: { name: "file-memory-integration" },
      memories: [
        {
          definition: defineMemory({
            provider: fileMemory({ backend }),
            scope: (context) => [context.session.auth.current!.principalId],
          }),
          slot: "facts",
        },
      ],
    });

    await runtime.run(async () => {
      const first = await runTurn({
        message: "Call facts__save_memory with one concise memory.",
        principalId: "user-1",
      });
      const recalled = await runTurn({
        message: "Show the persistent context you received.",
        principalId: "user-1",
      });
      const isolated = await runTurn({
        message: "Show the persistent context you received.",
        principalId: "user-2",
      });
      expect(
        first.some(
          (event) =>
            event.type === "actions.requested" &&
            event.data.actions.some(
              (action) => action.kind === "tool-call" && action.toolName === "facts__save_memory",
            ),
        ),
      ).toBe(true);
      const recalledMessage = filterEventsByType(recalled, "message.completed").at(-1)?.data
        .message;
      const isolatedMessage = filterEventsByType(isolated, "message.completed").at(-1)?.data
        .message;
      expect(recalledMessage).toContain("# Persistent memories");
      expect(recalledMessage).toContain("0: structured-output");
      expect(isolatedMessage).not.toContain("# Persistent memories");
      expect(isolatedMessage).not.toContain("structured-output");
    });
  });
});

async function runTurn(input: { readonly message: string; readonly principalId: string }) {
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
        "eve.continuationToken": `http:file-memory:${input.principalId}:${crypto.randomUUID()}`,
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
