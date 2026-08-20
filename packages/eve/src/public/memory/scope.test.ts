import { describe, expect, it } from "vitest";

import type { MemoryScopeContext } from "#public/memory/index.js";
import { byPrincipal } from "#public/memory/scope.js";

function createContext(
  input: {
    readonly authenticator?: string;
    readonly issuer?: string;
    readonly principalId?: string;
    readonly principalType?: string;
  } = {},
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
                authenticator: input.authenticator ?? "slack",
                issuer: input.issuer,
                principalId: input.principalId,
                principalType: input.principalType ?? "user",
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

  it("disables memory for anonymous and runtime principals but not local dev", () => {
    expect(
      byPrincipal(
        createContext({
          authenticator: "none",
          principalId: "anonymous",
          principalType: "anonymous",
        }),
      ),
    ).toBeNull();
    expect(
      byPrincipal(
        createContext({ authenticator: "app", principalId: "eve:app", principalType: "runtime" }),
      ),
    ).toBeNull();
    expect(
      byPrincipal(
        createContext({
          authenticator: "local-dev",
          principalId: "local-dev",
          principalType: "local-dev",
        }),
      ),
    ).toBe(JSON.stringify(["local-dev", "local-dev", null, "local-dev"]));
  });
});
