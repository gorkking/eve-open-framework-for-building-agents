import { afterEach, describe, expect, it, vi } from "vitest";

import { getVercelOidcToken } from "./vercel-oidc-hosted.js";

const requestContextSymbol = Symbol.for("@vercel/request-context");

function setRequestContext(value: unknown): void {
  (globalThis as Record<symbol, unknown>)[requestContextSymbol] = value;
}

afterEach(() => {
  vi.unstubAllEnvs();
  setRequestContext(undefined);
});

describe("getVercelOidcToken", () => {
  it("prefers the request-scoped token", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "environment-token");
    setRequestContext({
      get: () => ({ headers: { "x-vercel-oidc-token": "request-token" } }),
    });

    await expect(getVercelOidcToken()).resolves.toBe("request-token");
  });

  it("falls back to the function environment", async () => {
    vi.stubEnv("VERCEL_OIDC_TOKEN", "environment-token");

    await expect(getVercelOidcToken()).resolves.toBe("environment-token");
  });

  it("rejects when Vercel supplied no ambient token", async () => {
    await expect(getVercelOidcToken()).rejects.toThrow(
      "The 'x-vercel-oidc-token' header is missing from the request.",
    );
  });
});
