import { describe, expect, it } from "vitest";

import {
  createVercelBuildOutputPlan,
  createVercelWorkflowFunctionConfig,
} from "#internal/host/vercel-output.js";
import { createEveWorkflowQueueTrigger } from "#internal/workflow/queue-namespace.js";

const FRAMEWORK = {
  slug: "eve",
  version: "1.2.3",
} as const;

describe("createVercelBuildOutputPlan", () => {
  it("projects and deduplicates standalone routes with static routes before parameters", () => {
    const plan = createVercelBuildOutputPlan({
      framework: FRAMEWORK,
      routes: [
        { path: "/overlap/:slug" },
        { path: "/" },
        { path: "/overlap/static" },
        { path: "/overlap/:slug" },
        { path: "/eve/v1/session/:sessionId/stream" },
        { path: "/.well-known/workflow/v1/flow" },
      ],
    });

    expect(plan.sharedServerFunctionPath).toBe("__server.func");
    expect(plan.workflowFunctionPath).toBe(".well-known/workflow/v1/flow.func");
    expect(plan.config).toEqual({
      version: 3,
      framework: FRAMEWORK,
      routes: [
        { handle: "filesystem" },
        {
          src: "/\\.well-known/workflow/v1/flow",
          dest: "/.well-known/workflow/v1/flow",
        },
        { src: "/overlap/static", dest: "/overlap/static" },
        { src: "/", dest: "/index" },
        {
          src: "/eve/v1/session/(?<sessionId>[^/]+)/stream",
          dest: "/eve/v1/session/[sessionId]/stream",
        },
        { src: "/overlap/(?<slug>[^/]+)", dest: "/overlap/[slug]" },
        { src: "/(.*)", dest: "/__server" },
      ],
    });
    expect(plan.routeAliases).toEqual([
      { functionPath: "overlap/static.func", routePath: "/overlap/static" },
      { functionPath: "index.func", routePath: "/" },
      {
        functionPath: "eve/v1/session/[sessionId]/stream.func",
        routePath: "/eve/v1/session/:sessionId/stream",
      },
      { functionPath: "overlap/[slug].func", routePath: "/overlap/:slug" },
    ]);
  });

  it("emits only eve protocol aliases for a co-deployed service", () => {
    const plan = createVercelBuildOutputPlan({
      crons: [
        { path: "/eve/v1/cron/token", schedule: "*/15 * * * *" },
        { path: "/api/host-cleanup", schedule: "0 0 * * *" },
        { path: "/eve/v1/cron/token", schedule: "*/15 * * * *" },
      ],
      framework: FRAMEWORK,
      mode: "service",
      publicRoutePrefix: "eve/agents/support/",
      routes: [
        { path: "/" },
        { path: "/custom-webhook" },
        { path: "/eve/v1/health" },
        { path: "/eve/v1/session/:sessionId" },
      ],
    });

    expect(plan.sharedServerFunctionPath).toBe("__server.func");
    expect(plan.config).toEqual({
      version: 3,
      framework: FRAMEWORK,
      routes: [
        { handle: "filesystem" },
        {
          src: "/\\.well-known/workflow/v1/flow",
          dest: "/.well-known/workflow/v1/flow",
        },
        { src: "/eve/v1/health", dest: "/__server" },
        {
          src: "/eve/v1/session/(?<sessionId>[^/]+)",
          dest: "/__server",
        },
      ],
      crons: [
        {
          path: "/eve/agents/support/eve/v1/cron/token",
          schedule: "*/15 * * * *",
        },
        { path: "/api/host-cleanup", schedule: "0 0 * * *" },
      ],
    });
    expect(plan.routeAliases).toEqual([
      { functionPath: "eve/v1/health.func", routePath: "/eve/v1/health" },
      {
        functionPath: "eve/v1/session/[sessionId].func",
        routePath: "/eve/v1/session/:sessionId",
      },
    ]);
  });

  it("rejects route syntax that cannot be projected exactly", () => {
    for (const path of [
      "relative",
      "/trailing/",
      "/wild/**",
      "/bad/:not-valid",
      "/repeat/:id/:id",
      "/escape/../outside",
    ]) {
      expect(() =>
        createVercelBuildOutputPlan({
          framework: FRAMEWORK,
          routes: [{ path }],
        }),
      ).toThrow();
    }
  });

  it("escapes regular-expression syntax in static route segments", () => {
    const plan = createVercelBuildOutputPlan({
      framework: FRAMEWORK,
      mode: "service",
      routes: [{ path: "/eve/v1/hooks/a.b+(c){d}|e^f$" }],
    });

    expect(plan.config.routes).toContainEqual({
      src: "/eve/v1/hooks/a\\.b\\+\\(c\\)\\{d\\}\\|e\\^f\\$",
      dest: "/__server",
    });
  });
});

describe("createVercelWorkflowFunctionConfig", () => {
  it("preserves base settings and installs queue-specific workflow settings", () => {
    const config = createVercelWorkflowFunctionConfig({
      baseConfig: {
        environment: {
          BASE: "base",
          WORKFLOW_PRECONDITION_GUARD: "0",
        },
        handler: "server/index.mjs",
        memory: 2048,
        runtime: "nodejs24.x",
      },
      workflow: {
        agentName: "support-agent",
        environment: {
          EXTRA: "workflow",
        },
        publicRoutePrefix: "eve/agents/support/",
      },
    });

    expect(config).toEqual({
      handler: "server/index.mjs",
      memory: 2048,
      runtime: "nodejs24.x",
      maxDuration: "max",
      experimentalTriggers: [createEveWorkflowQueueTrigger("support-agent")],
      environment: {
        BASE: "base",
        EXTRA: "workflow",
        EVE_PUBLIC_ROUTE_PREFIX: "/eve/agents/support",
        WORKFLOW_PRECONDITION_GUARD: "1",
      },
    });
  });
});
