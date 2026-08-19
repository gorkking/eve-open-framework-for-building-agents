import { describe, expect, it } from "vitest";

import { composeRuntimeBasePrompt } from "#runtime/prompt/compose.js";

describe("composeRuntimeBasePrompt", () => {
  it("includes agent messaging instructions when subagents are available and persistent sessions are enabled", () => {
    const prompt = composeRuntimeBasePrompt({
      persistentSubagentSessions: true,
      subagentsAvailable: true,
    });

    expect(prompt).toContainEqual(expect.stringContaining("agentId"));
    expect(prompt).toContainEqual(expect.stringContaining("<agents>"));
  });

  it("omits agent messaging instructions when persistent sessions are not enabled", () => {
    const prompt = composeRuntimeBasePrompt({
      subagentsAvailable: true,
    });

    expect(prompt).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
    expect(prompt).not.toContainEqual(expect.stringContaining("<agents>"));
  });

  it("instructs task-mode parents when admission parks until a notification", () => {
    const prompt = composeRuntimeBasePrompt({
      persistentSubagentSessions: true,
      subagentsAvailable: true,
      tasksEnabled: true,
    });

    expect(prompt).toContainEqual(expect.stringContaining("resolves only to admitted tasks"));
    expect(prompt).toContainEqual(expect.stringContaining("synchronous result"));
    expect(prompt).toContainEqual(expect.stringContaining("parks your current turn"));
    expect(prompt).toContainEqual(expect.stringContaining("notify you"));
  });

  it("omits agent messaging instructions when subagents are unavailable", () => {
    const prompt = composeRuntimeBasePrompt({
      persistentSubagentSessions: true,
      subagentsAvailable: false,
    });

    expect(prompt).not.toContainEqual(expect.stringContaining("Pass `agentId`"));
    expect(prompt).not.toContainEqual(expect.stringContaining("<agents>"));
  });
});
