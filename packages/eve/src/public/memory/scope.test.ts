import { describe, expect, it } from "vitest";

import type { MemoryScopeContext } from "#public/memory/index.js";
import { byPrincipal } from "#public/memory/scope.js";

function createContext(
  input: { readonly issuer?: string; readonly principalId?: string } = {},
): MemoryScopeContext {
  return {
    abortSignal: new AbortController().signal,
    channel: {},
    session: {
      auth: {
        current:
          input.principalId === undefined
            ? null
            : {
                attributes: {},
                authenticator: "slack",
                issuer: input.issuer,
                principalId: input.principalId,
                principalType: "user",
              },
        initiator: null,
      },
      id: "session-1",
    },
  };
}

describe("memory scope", () => {
  it("derives one canonical principal scope and disables unauthenticated memory", () => {
    expect(byPrincipal(createContext({ principalId: "U123" }))).toBe(
      JSON.stringify(["user", "slack", null, "U123"]),
    );
    expect(
      byPrincipal(createContext({ issuer: "https://slack.com/team/T123", principalId: "U123" })),
    ).toBe(JSON.stringify(["user", "slack", "https://slack.com/team/T123", "U123"]));
    expect(byPrincipal(createContext())).toBeNull();
  });
});
