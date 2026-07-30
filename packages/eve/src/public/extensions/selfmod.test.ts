import { describe, expect, it } from "vitest";

import { defineSelfModifyingAgent } from "#public/extensions/selfmod.js";
import { readSelfModifyingSandboxDefinition } from "#shared/selfmod-definition.js";

describe("defineSelfModifyingAgent", () => {
  it("stamps the development-only definition and carries its live-tree sandbox", () => {
    const definition = defineSelfModifyingAgent({
      development: true,
      instructions: "Keep edits small.",
    });

    expect(definition).toEqual({
      development: true,
      instructions: "Keep edits small.",
      kind: "selfmod",
    });
    expect(readSelfModifyingSandboxDefinition(definition)).toMatchObject({
      backend: { name: "eve-selfmod" },
    });
  });
});
