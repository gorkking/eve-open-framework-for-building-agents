import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { authorizeResendMarketplaceSetup, type MarketplaceOAuthDeps } from "./marketplace-oauth.js";

function effects(outputs: Array<{ ok: boolean; stdout: string }>): MarketplaceOAuthDeps {
  return {
    runVercelCaptureStdout: vi.fn(async () => outputs.shift() ?? { ok: true, stdout: "{}" }),
  };
}

describe("Resend Marketplace setup OAuth", () => {
  it("authorizes full_access and removes the temporary connector after cleanup", async () => {
    const deps = effects([
      {
        ok: true,
        stdout: JSON.stringify({
          id: "scl_setup",
          uid: "oauth/eve-resend-setup",
          supportedSubjectTypes: ["user"],
        }),
      },
      { ok: true, stdout: JSON.stringify({ token: "oauth_secret" }) },
      { ok: true, stdout: JSON.stringify({ deleted: 1 }) },
      { ok: true, stdout: JSON.stringify({ removed: true }) },
    ]);

    const authorization = await authorizeResendMarketplaceSetup({
      log: createFakePrompter().prompter.log,
      projectRoot: "/project",
      orgId: "team",
      deps,
    });
    expect(authorization.accessToken).toBe("oauth_secret");
    await authorization.cleanup();

    const calls = vi.mocked(deps.runVercelCaptureStdout).mock.calls.map((call) => call[0]);
    expect(calls[1]).toEqual(
      expect.arrayContaining([
        "connect",
        "token",
        "oauth/eve-resend-setup",
        "--scopes",
        "full_access",
        "--yes",
      ]),
    );
    expect(calls[2]).toEqual(
      expect.arrayContaining(["connect", "revoke-tokens", "--my-tokens", "--yes"]),
    );
    expect(calls[3]).toEqual(
      expect.arrayContaining(["connect", "remove", "--disconnect-all", "--yes"]),
    );
  });
});
