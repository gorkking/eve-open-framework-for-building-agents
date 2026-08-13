import { describe, expect, it } from "vitest";

import {
  createApplicationRouteRegistry,
  createApplicationRouteRegistryFromInput,
  mergeApplicationChannelRouteRegistrations,
} from "#internal/host/application-route-registry.js";

describe("mergeApplicationChannelRouteRegistrations", () => {
  it("applies authored-name overrides, disabled defaults, and framework-first path dedupe", () => {
    const registrations = mergeApplicationChannelRouteRegistrations({
      frameworkChannelNames: new Set(["callback", "eve", "shared"]),
      frameworkChannels: [
        {
          cors: { origin: ["https://framework.example"] },
          method: "POST",
          name: "eve",
          urlPath: "/framework/session",
        },
        { method: "POST", name: "callback", urlPath: "/callback" },
        {
          cors: { origin: ["https://framework-wins.example"] },
          method: "GET",
          name: "shared",
          urlPath: "/duplicate",
        },
      ],
      manifestChannels: [
        { kind: "disabled", name: "callback" },
        {
          cors: { origin: ["https://authored.example"] },
          kind: "channel",
          method: "POST",
          name: "eve",
          urlPath: "/authored/session",
        },
        {
          cors: { origin: ["https://deduped.example"] },
          kind: "channel",
          method: "GET",
          name: "custom",
          urlPath: "/duplicate",
        },
      ],
    });

    expect(registrations).toEqual([
      {
        cors: { origin: ["https://framework-wins.example"] },
        method: "GET",
        route: "/duplicate",
      },
      {
        cors: { origin: ["https://authored.example"] },
        method: "POST",
        route: "/authored/session",
      },
    ]);
  });

  it("rejects disable files that do not name a framework channel", () => {
    expect(() =>
      mergeApplicationChannelRouteRegistrations({
        frameworkChannelNames: new Set(["eve"]),
        frameworkChannels: [],
        manifestChannels: [{ kind: "disabled", name: "unknown" }],
      }),
    ).toThrow(
      'agent/channels/unknown.ts exports disableRoute() but "unknown" is not a framework channel',
    );
  });
});

describe("createApplicationRouteRegistryFromInput", () => {
  it("projects package, channel, workflow, development, and Vercel cron routes", () => {
    const cronRoute = "/eve/v1/cron/test-token";
    const cors = { methods: ["GET", "POST"], origin: ["https://example.com"] } as const;
    const registry = createApplicationRouteRegistryFromInput({
      development: true,
      frameworkChannelNames: new Set(),
      frameworkChannels: [],
      manifestChannels: [
        { cors, kind: "channel", method: "POST", name: "hooks", urlPath: "/hooks" },
        { cors, kind: "channel", method: "GET", name: "hooks", urlPath: "/hooks" },
        { cors, kind: "channel", method: "POST", name: "copy", urlPath: "/hooks" },
        {
          kind: "channel",
          method: "WEBSOCKET",
          name: "socket",
          urlPath: "/socket/:room",
        },
        {
          kind: "channel",
          method: "GET",
          name: "reserved-health",
          urlPath: "/eve/v1/health",
        },
      ],
      scheduleRegistrations: [
        { cron: "0 8 * * *" },
        { cron: "0 8 * * *" },
        { cron: "0 0 * * MON" },
      ],
      vercelCronRoute: cronRoute,
    });

    expect(registry.channelRegistrations).toEqual([
      { cors, method: "POST", route: "/hooks" },
      { cors, method: "GET", route: "/hooks" },
      { method: "WEBSOCKET", route: "/socket/:room" },
    ]);
    expect(registry.routes).toEqual([
      { kind: "home", method: "GET", path: "/" },
      { kind: "health", method: "GET", path: "/eve/v1/health" },
      { kind: "health", method: "HEAD", path: "/eve/v1/health" },
      { cors, kind: "channel", method: "POST", path: "/hooks" },
      { cors, kind: "channel-preflight", method: "OPTIONS", path: "/hooks" },
      { cors, kind: "channel", method: "GET", path: "/hooks" },
      { kind: "channel", method: "WEBSOCKET", path: "/socket/:room" },
      {
        kind: "workflow",
        method: "POST",
        path: "/.well-known/workflow/v1/flow",
      },
      {
        kind: "development-artifacts",
        method: "GET",
        path: "/eve/v1/dev/runtime-artifacts",
      },
      {
        kind: "development-schedule",
        method: "POST",
        path: "/eve/v1/dev/schedules/:scheduleId",
      },
      { kind: "vercel-cron", method: "ALL", path: cronRoute },
    ]);
    expect(registry.routePaths).toEqual([
      "/",
      "/eve/v1/health",
      "/hooks",
      "/socket/:room",
      "/.well-known/workflow/v1/flow",
      "/eve/v1/dev/runtime-artifacts",
      "/eve/v1/dev/schedules/:scheduleId",
      cronRoute,
    ]);
    expect(registry.vercelRoutes).toEqual(registry.routePaths.map((path) => ({ path })));
    expect(registry.vercelCrons).toEqual([
      { path: cronRoute, schedule: "0 8 * * *" },
      { path: cronRoute, schedule: "0 0 * * MON" },
    ]);
    expect(registry.vercelCronRoute).toBe(cronRoute);
  });

  it("omits development and cron projections unless requested", () => {
    const registry = createApplicationRouteRegistryFromInput({
      frameworkChannelNames: new Set(),
      frameworkChannels: [],
      manifestChannels: [],
      scheduleRegistrations: [{ cron: "0 8 * * *" }],
    });

    expect(registry.routes.map((route) => route.kind)).toEqual([
      "home",
      "health",
      "health",
      "workflow",
    ]);
    expect(registry.vercelCronRoute).toBeUndefined();
    expect(registry.vercelCrons).toEqual([]);
  });
});

describe("createApplicationRouteRegistry", () => {
  it("generates one unguessable cron route shared by H3 and Vercel schedules", () => {
    const preparedHost = {
      compileResult: {
        manifest: {
          channels: [],
        },
      },
      scheduleRegistrations: [{ cron: "*/15 * * * *" }],
    };

    const registry = createApplicationRouteRegistry(preparedHost, { vercelCron: true });

    expect(registry.vercelCronRoute).toMatch(/^\/eve\/v1\/cron\/[A-Za-z0-9_-]{43}$/u);
    expect(registry.routes).toContainEqual({
      kind: "vercel-cron",
      method: "ALL",
      path: registry.vercelCronRoute,
    });
    expect(registry.vercelCrons).toEqual([
      { path: registry.vercelCronRoute, schedule: "*/15 * * * *" },
    ]);
  });
});
