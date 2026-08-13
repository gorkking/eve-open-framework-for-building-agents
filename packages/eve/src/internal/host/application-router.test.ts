import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchMocks = vi.hoisted(() => ({
  http: vi.fn(),
  websocket: vi.fn(),
}));

vi.mock("./routes/channel-dispatch.js", () => ({
  dispatchChannelRequest: dispatchMocks.http,
  dispatchChannelWebSocketRequest: dispatchMocks.websocket,
}));

vi.mock("./routes/dev-runtime-artifacts.js", () => ({
  handleDevRuntimeArtifactsRequest: () => Response.json({ revision: "test" }),
}));

vi.mock("./routes/dev-schedule-dispatch.js", () => ({
  handleDevScheduleDispatchRequest: (_config: unknown, request: Request) =>
    Response.json({ path: new URL(request.url).pathname }),
}));

vi.mock("./routes/health.js", () => ({
  default: () => Response.json({ ok: true, status: "ready", workflowId: "test" }),
}));

const { createApplicationRouter } = await import("./application-router.js");

describe("createApplicationRouter", () => {
  beforeEach(() => {
    dispatchMocks.http.mockReset();
    dispatchMocks.websocket.mockReset();
    dispatchMocks.http.mockImplementation(async (event, routeKey) =>
      Response.json({ params: event.context.params, routeKey }),
    );
    dispatchMocks.websocket.mockResolvedValue({
      upgrade: () => ({ headers: { "x-eve-test": "1" } }),
    });
  });

  it("serves package routes and explicit HEAD health probes", async () => {
    const app = createApplicationRouter({
      agentName: "support-agent",
      artifacts: { kind: "production" },
      channels: [],
    });

    const home = await app.request("http://localhost/");
    expect(home.status).toBe(200);
    expect(await home.text()).toContain("support-agent");
    expect(home.headers.get("cache-control")).toBe("no-store");

    const health = await app.request("http://localhost/eve/v1/health", { method: "HEAD" });
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("");
  });

  it("uses H3 routing for decoded channel params and route precedence", async () => {
    const app = createApplicationRouter({
      agentName: "test",
      artifacts: { kind: "production" },
      channels: [
        { method: "POST", route: "/hooks/:id" },
        { method: "POST", route: "/hooks/fixed" },
      ],
    });

    const fixed = await app.request("http://localhost/hooks/fixed", { method: "POST" });
    expect(await fixed.json()).toEqual({ routeKey: "POST /hooks/fixed" });

    const dynamic = await app.request("http://localhost/hooks/a%20b", { method: "POST" });
    expect(await dynamic.json()).toEqual({
      params: { id: "a%20b" },
      routeKey: "POST /hooks/:id",
    });
  });

  it("handles CORS preflight and regular channel responses", async () => {
    const app = createApplicationRouter({
      agentName: "test",
      artifacts: { kind: "production" },
      channels: [
        {
          cors: { methods: ["POST"], origin: ["https://example.com"] },
          method: "POST",
          route: "/hooks",
        },
      ],
    });

    const preflight = await app.request("http://localhost/hooks", {
      headers: {
        origin: "https://example.com",
        "access-control-request-method": "POST",
      },
      method: "OPTIONS",
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("access-control-allow-origin")).toBe("https://example.com");

    const response = await app.request("http://localhost/hooks", {
      headers: { origin: "https://example.com" },
      method: "POST",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("https://example.com");
  });

  it("attaches CrossWS hooks to websocket upgrade responses", async () => {
    const app = createApplicationRouter({
      agentName: "test",
      artifacts: { kind: "production" },
      channels: [{ method: "WEBSOCKET", route: "/socket/:room" }],
    });

    const response = await app.request("http://localhost/socket/general");

    expect(response.status).toBe(426);
    expect(response).toHaveProperty("crossws");
    expect(dispatchMocks.websocket).toHaveBeenCalledOnce();
  });

  it("serves HTTP GET and WebSocket upgrades from the same channel path", async () => {
    const app = createApplicationRouter({
      agentName: "test",
      artifacts: { kind: "production" },
      channels: [
        { method: "GET", route: "/socket/:room" },
        { method: "WEBSOCKET", route: "/socket/:room" },
      ],
    });

    const httpResponse = await app.request("http://localhost/socket/general");
    expect(httpResponse.status).toBe(200);
    await expect(httpResponse.json()).resolves.toEqual({
      params: { room: "general" },
      routeKey: "GET /socket/:room",
    });

    const upgradeResponse = await app.request("http://localhost/socket/general", {
      headers: { upgrade: "websocket" },
    });
    expect(upgradeResponse.status).toBe(426);
    expect(upgradeResponse).toHaveProperty("crossws");
    expect(dispatchMocks.websocket).toHaveBeenCalledWith(
      expect.anything(),
      "WEBSOCKET /socket/:room",
      { kind: "production" },
    );
  });

  it("mounts an optional platform cron handler", async () => {
    const app = createApplicationRouter({
      agentName: "test",
      artifacts: { kind: "production" },
      channels: [],
      cron: {
        handler: (request) =>
          Response.json({ authorization: request.headers.get("authorization") }),
        route: "/eve/v1/cron/secret",
      },
    });

    const response = await app.request("http://localhost/eve/v1/cron/secret", {
      headers: { authorization: "Bearer test" },
    });
    expect(await response.json()).toEqual({ authorization: "Bearer test" });
  });

  it("keeps production errors opaque and development errors diagnostic", async () => {
    const production = createApplicationRouter({
      agentName: "test",
      artifacts: { kind: "production" },
      channels: [],
      workflow: {
        handler: () => {
          throw new Error("private failure");
        },
        route: "/flow",
      },
    });
    const productionResponse = await production.request("http://localhost/flow", {
      method: "POST",
    });
    expect(await productionResponse.json()).toEqual({
      error: true,
      status: 500,
      unhandled: true,
    });

    const development = createApplicationRouter({
      agentName: "test",
      artifacts: {
        appRoot: "/tmp/eve-app",
        devRuntimeArtifactsPointerPath: "/tmp/eve-app/.eve/artifacts",
        kind: "development",
        moduleMapLoaderPath: "/tmp/eve-app/.eve/module-map.mjs",
      },
      channels: [],
      workflow: {
        handler: () => {
          throw new Error("diagnostic failure");
        },
        route: "/flow",
      },
    });
    const developmentResponse = await development.request("http://localhost/flow", {
      method: "POST",
    });
    expect(await developmentResponse.json()).toMatchObject({
      error: true,
      message: "diagnostic failure",
      status: 500,
      unhandled: true,
    });
  });
});
