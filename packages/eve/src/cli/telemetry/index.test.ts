import { describe, expect, it } from "vitest";
import { canonicalCommand } from "#cli/telemetry/index.js";

describe("canonicalCommand", () => {
  it("records default and nested command paths without user-supplied values", () => {
    expect(canonicalCommand([])).toBe("dev");
    expect(canonicalCommand(["dev", "https://agent.example"])).toBe("dev");
    expect(canonicalCommand(["registry", "search", "private-query"])).toBe("registry:search");
    expect(canonicalCommand(["logs"])).toBe("logs:show");
  });

  it("records supported top-level commands and buckets unknown commands", () => {
    expect(canonicalCommand(["set", "--model", "private/model"])).toBe("set");
    expect(canonicalCommand(["not-a-command", "private-argument"])).toBe("unknown");
  });
});
