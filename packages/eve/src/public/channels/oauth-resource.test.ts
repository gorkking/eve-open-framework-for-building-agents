import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import {
  oauthResource,
  readOAuthResourceOptions,
  routeAuth,
  type AuthFn,
} from "#public/channels/auth.js";

const principal: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

describe("oauthResource", () => {
  it("preserves the ordered auth walk and attaches non-enumerable metadata", async () => {
    const skip = vi.fn<AuthFn<Request>>(() => null);
    const accept = vi.fn<AuthFn<Request>>(() => principal);
    const auth = oauthResource([skip, accept], {
      issuer: "https://auth.example",
      scopes: ["agent:invoke"],
    });

    await expect(routeAuth(new Request("https://agent.example/mcp"), auth)).resolves.toBe(
      principal,
    );
    expect(skip).toHaveBeenCalledOnce();
    expect(accept).toHaveBeenCalledOnce();
    expect(Object.keys(auth)).toEqual([]);
    expect(readOAuthResourceOptions(auth)).toEqual({
      issuer: "https://auth.example",
      scopes: ["agent:invoke"],
    });
  });

  it("rejects invalid resource metadata at authoring time", () => {
    expect(() =>
      oauthResource(() => principal, {
        authorizationServers: [],
      }),
    ).toThrow("at least one absolute authorization server URL");
    expect(() =>
      oauthResource(() => principal, {
        issuer: "https://auth.example",
        metadataPath: "oauth-protected-resource",
      }),
    ).toThrow("metadataPath must start with '/'");
  });
});
