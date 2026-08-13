import { H3 } from "h3";
import { beforeEach, describe, expect, it, vi } from "vitest";

const webSocketMocks = vi.hoisted(() => ({
  adapter: vi.fn(),
  handleWebUpgrade: vi.fn(),
}));

vi.mock("crossws/adapters/vercel", () => ({ default: webSocketMocks.adapter }));

import {
  createVercelApplicationHandler,
  type VercelApplicationContext,
} from "#internal/host/vercel-application.js";

interface ObservedRequest extends Request {
  readonly ip?: string;
  readonly runtime?: {
    readonly name: string;
    readonly marker?: string;
    readonly vercel?: { readonly context: VercelApplicationContext | undefined };
  };
  readonly waitUntil?: (task: Promise<unknown>) => void;
}

describe("createVercelApplicationHandler", () => {
  beforeEach(() => {
    webSocketMocks.adapter.mockReset().mockReturnValue({
      handleWebUpgrade: webSocketMocks.handleWebUpgrade,
    });
    webSocketMocks.handleWebUpgrade.mockReset().mockResolvedValue(undefined);
  });

  it("attaches Vercel runtime context, waitUntil, and the trusted forwarded IP", async () => {
    let observedRequest: ObservedRequest | undefined;
    const backgroundTask = Promise.resolve();
    const app = new H3().get("/", (event) => {
      observedRequest = event.req as ObservedRequest;
      event.waitUntil(backgroundTask);
      return "ok";
    });
    const context = { waitUntil: vi.fn<(task: Promise<unknown>) => void>() };
    const handler = createVercelApplicationHandler({ fetch: app.fetch });
    const response = await handler.fetch(
      new Request("https://example.com/", {
        headers: { "x-forwarded-for": " 203.0.113.8, 10.0.0.1 " },
      }),
      context,
    );

    expect(await response.text()).toBe("ok");
    expect(observedRequest?.ip).toBe("203.0.113.8");
    expect(observedRequest?.runtime).toEqual({ name: "vercel", vercel: { context } });
    expect(observedRequest?.waitUntil).toBe(context.waitUntil);
    expect(context.waitUntil).toHaveBeenCalledWith(backgroundTask);
  });

  it("preserves existing request runtime fields and waitUntil when context omits it", async () => {
    const existingWaitUntil = vi.fn<(task: Promise<unknown>) => void>();
    const runtime = { marker: "kept", name: "custom" };
    const request = new Request("https://example.com/") as ObservedRequest;
    Object.assign(request, { runtime, waitUntil: existingWaitUntil });
    let observed: ObservedRequest | undefined;
    const context = {};
    const handler = createVercelApplicationHandler({
      fetch: async (incoming) => {
        observed = incoming as ObservedRequest;
        return new Response();
      },
    });

    await handler.fetch(request, context);

    expect(observed?.runtime).toBe(runtime);
    expect(observed?.runtime).toEqual({
      marker: "kept",
      name: "custom",
      vercel: { context },
    });
    expect(observed?.waitUntil).toBe(existingWaitUntil);
  });

  it("prepares WebSocket requests before handing them to CrossWS", async () => {
    const upgradeResponse = new Response(null, { status: 204 });
    webSocketMocks.handleWebUpgrade.mockResolvedValue(upgradeResponse);
    const fetch = vi.fn(async () => new Response("http fallback"));
    const context = { waitUntil: vi.fn<(task: Promise<unknown>) => void>() };
    const handler = createVercelApplicationHandler({ fetch, websocket: true });
    const request = new Request("https://example.com/socket", {
      headers: {
        connection: "upgrade",
        upgrade: "WebSocket",
        "x-forwarded-for": "198.51.100.4",
      },
    });

    await expect(handler.fetch(request, context)).resolves.toBe(upgradeResponse);

    expect(fetch).not.toHaveBeenCalled();
    expect(webSocketMocks.handleWebUpgrade).toHaveBeenCalledOnce();
    const upgradedRequest = webSocketMocks.handleWebUpgrade.mock.calls[0]![0] as ObservedRequest;
    expect(upgradedRequest.ip).toBe("198.51.100.4");
    expect(upgradedRequest.runtime?.vercel?.context).toBe(context);
    expect(upgradedRequest.waitUntil).toBe(context.waitUntil);
  });

  it("falls through to H3 when Vercel cannot upgrade the WebSocket", async () => {
    const fetch = vi.fn(async () => new Response("fallback", { status: 426 }));
    const handler = createVercelApplicationHandler({ fetch, websocket: true });

    const response = await handler.fetch(
      new Request("https://example.com/socket", { headers: { upgrade: "websocket" } }),
    );

    expect(webSocketMocks.handleWebUpgrade).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
    expect(response.status).toBe(426);
  });

  it("resolves CrossWS hooks through the application router", async () => {
    const hooks = { open: vi.fn() };
    const response = Object.assign(new Response("upgrade", { status: 426 }), {
      crossws: hooks,
    });
    const fetch = vi.fn(async () => response);

    createVercelApplicationHandler({ fetch, websocket: true });

    const adapterOptions = webSocketMocks.adapter.mock.calls[0]![0] as {
      readonly resolve: (request: Request) => Promise<unknown>;
    };
    await expect(adapterOptions.resolve(new Request("https://example.com/socket"))).resolves.toBe(
      hooks,
    );
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("rejects a WebSocket upgrade resolved to an ordinary successful HTTP route", async () => {
    const fetch = vi.fn(async () => new Response("ordinary response"));

    createVercelApplicationHandler({ fetch, websocket: true });

    const adapterOptions = webSocketMocks.adapter.mock.calls[0]![0] as {
      readonly resolve: (request: Request) => Promise<Partial<import("crossws").Hooks>>;
    };
    const request = new Request("https://example.com/not-a-socket", {
      headers: { upgrade: "websocket" },
    });
    const hooks = await adapterOptions.resolve(request);
    const response = await hooks.upgrade?.(request);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(404);
  });

  it("does not initialize or invoke CrossWS when WebSockets are disabled", async () => {
    const fetch = vi.fn(async () => new Response("ok"));
    const handler = createVercelApplicationHandler({ fetch });

    const response = await handler.fetch(new Request("https://example.com/"));

    expect(await response.text()).toBe("ok");
    expect(webSocketMocks.adapter).not.toHaveBeenCalled();
    expect(webSocketMocks.handleWebUpgrade).not.toHaveBeenCalled();
  });

  it("does not ask CrossWS to handle ordinary HTTP requests", async () => {
    const handler = createVercelApplicationHandler({
      fetch: async () => new Response("ok"),
      websocket: true,
    });

    await handler.fetch(new Request("https://example.com/"));

    expect(webSocketMocks.handleWebUpgrade).not.toHaveBeenCalled();
  });
});
