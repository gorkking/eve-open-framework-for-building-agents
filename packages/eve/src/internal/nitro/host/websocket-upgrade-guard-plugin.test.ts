import { describe, expect, it, vi } from "vitest";

import { installWebSocketUpgradeGuard } from "./websocket-upgrade-guard-plugin.js";

function websocketRequest(path = "/socket"): Request {
  return new Request(`http://eve.test${path}`, { headers: { upgrade: "websocket" } });
}

describe("installWebSocketUpgradeGuard", () => {
  it("preserves hooks from an explicit WebSocket route", async () => {
    const crossws = { open: vi.fn() };
    const response = Object.assign(new Response("upgrade", { status: 426 }), { crossws });
    const cancel = vi.spyOn(response.body!, "cancel");
    const nitroApp = { fetch: vi.fn(async (_request: Request) => response) };

    installWebSocketUpgradeGuard(nitroApp);

    const resolved = (await nitroApp.fetch(websocketRequest())) as typeof response;
    expect(resolved).toBe(response);
    expect(resolved.crossws).toBe(crossws);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("rejects an upgrade resolved to an ordinary successful HTTP route", async () => {
    const nitroApp = {
      fetch: vi.fn(async (_request: Request) => new Response("ordinary route")),
    };

    installWebSocketUpgradeGuard(nitroApp);

    const response = (await nitroApp.fetch(websocketRequest())) as Response & {
      crossws: { upgrade: () => Response | Promise<Response> };
    };
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("No WebSocket route matches this request.");
    const upgradeResponse = await response.crossws.upgrade();
    expect(upgradeResponse).toBe(response);
  });

  it("preserves an HTTP error while exposing it to the upgrade adapter", async () => {
    const original = new Response("missing", { status: 404 });
    const nitroApp = { fetch: vi.fn(async (_request: Request) => original) };

    installWebSocketUpgradeGuard(nitroApp);

    const response = (await nitroApp.fetch(websocketRequest())) as Response & {
      crossws: { upgrade: () => Response | Promise<Response> };
    };
    expect(response).toBe(original);
    expect(await response.crossws.upgrade()).toBe(original);
  });

  it("leaves ordinary HTTP requests unchanged", async () => {
    const original = new Response("ok");
    const nitroApp = { fetch: vi.fn(async (_request: Request) => original) };

    installWebSocketUpgradeGuard(nitroApp);

    await expect(nitroApp.fetch(new Request("http://eve.test/socket"))).resolves.toBe(original);
  });
});
