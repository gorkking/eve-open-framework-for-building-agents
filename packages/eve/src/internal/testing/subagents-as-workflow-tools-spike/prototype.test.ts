import { describe, expect, it } from "vitest";

import { isBrandedToolEntry } from "#shared/dynamic-tool-definition.js";

import * as prototype from "./prototype.js";

describe("workflow-backed tool spike", () => {
  it("uses an ordinary defineTool value for a workflow-backed executor", () => {
    const tool = prototype.defineWorkflowToolProbe();

    expect(isBrandedToolEntry(tool)).toBe(true);
    expect(tool.execute).toBe(prototype.executeWorkflowToolProbe);
  });

  it("lowers local and remote definitions to real defineTool values", () => {
    const local = prototype.defineSubagent({
      description: "Research locally",
      nodeId: "subagents/research",
    });
    const remote = prototype.defineRemoteSubagent({
      description: "Review remotely",
      nodeId: "remote/reviewer",
      url: "https://reviewer.example.com",
    });

    expect(isBrandedToolEntry(local)).toBe(true);
    expect(local.execute).toBe(prototype.executeLocalSubagent);
    expect(local[prototype.WORKFLOW_SUBAGENT_TARGET]).toEqual({
      kind: "local",
      nodeId: "subagents/research",
    });

    expect(isBrandedToolEntry(remote)).toBe(true);
    expect(remote.execute).toBe(prototype.executeRemoteSubagent);
    expect(remote[prototype.WORKFLOW_SUBAGENT_TARGET]).toEqual({
      kind: "remote",
      nodeId: "remote/reviewer",
      url: "https://reviewer.example.com",
    });
  });

  it("does not expose a runAgent escape hatch", () => {
    expect("runAgent" in prototype).toBe(false);
  });
});
