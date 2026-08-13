import { describe, expect, it, vi } from "vitest";

import { createApplicationWebSocketResolver } from "#internal/host/application-websocket.js";

describe("createApplicationWebSocketResolver", () => {
  it("returns only hooks explicitly attached by the application router", async () => {
    const hooks = { open: vi.fn() };
    const fetch = vi.fn(async () =>
      Object.assign(new Response("upgrade", { status: 426 }), { crossws: hooks }),
    );
    const request = new Request("https://example.com/socket", {
      headers: { upgrade: "websocket" },
    });

    await expect(createApplicationWebSocketResolver(fetch)(request)).resolves.toBe(hooks);
    expect(fetch).toHaveBeenCalledWith(request);
  });

  it("rejects an upgrade when an ordinary HTTP route returns successfully", async () => {
    const resolve = createApplicationWebSocketResolver(async () => new Response("ordinary"));
    const request = new Request("https://example.com/", {
      headers: { upgrade: "websocket" },
    });

    const hooks = await resolve(request);
    const response = await hooks.upgrade?.(request);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(404);
    await expect((response as Response).text()).resolves.toBe(
      "No WebSocket route matches this request.",
    );
  });

  it("preserves an HTTP error produced while resolving the route", async () => {
    const notFound = new Response("missing", { status: 404 });
    const resolve = createApplicationWebSocketResolver(async () => notFound);
    const request = new Request("https://example.com/missing", {
      headers: { upgrade: "websocket" },
    });

    const hooks = await resolve(request);

    expect(await hooks.upgrade?.(request)).toBe(notFound);
  });
});
