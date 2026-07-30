import { describe, expect, it } from "vitest";

import { escapeAuthChallengeParameter } from "#shared/http-auth.js";

describe("escapeAuthChallengeParameter", () => {
  it("escapes quotes and backslashes for a quoted auth parameter", () => {
    expect(escapeAuthChallengeParameter('agent\\"invoke')).toBe('agent\\\\\\"invoke');
  });
});
