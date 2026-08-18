import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { SessionKey } from "#context/keys.js";
import { byPrincipal } from "#public/memory/scope.js";

function createContext(
  input: { readonly issuer?: string; readonly principalId?: string } = {},
): ContextContainer {
  const context = new ContextContainer();
  context.set(SessionKey, {
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
    sessionId: "session-1",
    turn: { id: "turn-1", sequence: 0 },
  });
  return context;
}

describe("memory scope", () => {
  it("derives one canonical principal scope and disables unauthenticated memory", () => {
    expect(contextStorage.run(createContext({ principalId: "U123" }), () => byPrincipal())).toBe(
      JSON.stringify(["user", "slack", null, "U123"]),
    );
    expect(
      contextStorage.run(
        createContext({ issuer: "https://slack.com/team/T123", principalId: "U123" }),
        () => byPrincipal(),
      ),
    ).toBe(JSON.stringify(["user", "slack", "https://slack.com/team/T123", "U123"]));
    expect(contextStorage.run(createContext(), () => byPrincipal())).toBeNull();
  });
});
