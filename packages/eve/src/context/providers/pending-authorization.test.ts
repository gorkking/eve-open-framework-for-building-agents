import { describe, expect, it } from "vitest";

import { ContextContainer } from "#context/container.js";
import { pendingAuthorizationProvider } from "#context/providers/pending-authorization.js";
import { getPendingAuthorization, setPendingAuthorization } from "#harness/authorization.js";
import type { HarnessSession } from "#harness/types.js";

describe("pendingAuthorizationProvider", () => {
  it("rebuilds pending challenges from durable session state", async () => {
    const state = setPendingAuthorization(undefined, {
      challenges: [
        {
          attemptId: "attempt-linear",
          challenge: { userCode: "OLD-CODE", url: "https://idp.example/linear" },
          hookUrl: "https://agent.example/linear",
          name: "linear",
          principal: { id: "user-1", issuer: "idp", type: "user" },
        },
      ],
    });

    const result = await pendingAuthorizationProvider.create(new ContextContainer(), {
      state,
    } as HarnessSession);

    expect(result?.value).toEqual(getPendingAuthorization(state));
  });
});
