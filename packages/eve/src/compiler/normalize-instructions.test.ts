import { beforeEach, describe, expect, it, vi } from "vitest";

import { compileInstructionsEntry } from "#compiler/normalize-instructions.js";
import { createModuleSourceRef, type InstructionsSourceRef } from "#discover/manifest.js";
import { defineDynamic, defineInstructions } from "#public/instructions/index.js";

const mocks = vi.hoisted(() => ({
  loadModuleBackedDefinition: vi.fn(),
}));

vi.mock("#compiler/normalize-helpers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#compiler/normalize-helpers.js")>()),
  loadModuleBackedDefinition: mocks.loadModuleBackedDefinition,
}));

describe("compileInstructionsEntry", () => {
  beforeEach(() => {
    mocks.loadModuleBackedDefinition.mockReset();
  });

  it("compiles role-aware module instructions", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue(
      defineInstructions({ content: "Persisted profile.", role: "user" }),
    );

    await expect(
      compileInstructionsEntry(
        "/app/agent",
        createModuleSourceRef({ logicalPath: "instructions/profile.ts" }),
      ),
    ).resolves.toMatchObject({
      definition: {
        content: "Persisted profile.",
        name: "instructions/profile",
        role: "user",
      },
      kind: "instructions",
    });
  });

  it("normalizes markdown files to system-role content", async () => {
    const source = {
      definition: { content: "Standing policy.", role: "system" },
      logicalPath: "instructions.md",
      sourceId: "instructions.md",
      sourceKind: "markdown",
    } satisfies InstructionsSourceRef;

    await expect(compileInstructionsEntry("/app/agent", source)).resolves.toMatchObject({
      definition: { content: "Standing policy.", name: "instructions", role: "system" },
      kind: "instructions",
    });
  });

  it("accepts step-scoped dynamic instructions", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue(
      defineDynamic({
        events: {
          "step.started": () => defineInstructions({ content: "Step policy." }),
        },
      }),
    );

    await expect(
      compileInstructionsEntry(
        "/app/agent",
        createModuleSourceRef({ logicalPath: "instructions/step.ts" }),
      ),
    ).resolves.toMatchObject({
      definition: { eventNames: ["step.started"], slug: "step" },
      kind: "dynamic-instructions",
    });
  });

  it("rejects unsupported dynamic instruction events", async () => {
    mocks.loadModuleBackedDefinition.mockResolvedValue({
      events: { "message.completed": () => null },
      kind: "eve:dynamic",
    });

    await expect(
      compileInstructionsEntry(
        "/app/agent",
        createModuleSourceRef({ logicalPath: "instructions/invalid.ts" }),
      ),
    ).rejects.toThrow('received "message.completed"');
  });
});
