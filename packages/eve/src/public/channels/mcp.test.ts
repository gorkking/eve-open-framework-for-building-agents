import { describe, expect, it } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import {
  attachAgentInfoRouteResponse,
  attachRouteAgent,
} from "#internal/nitro/routes/channel-route-context.js";
import { MCP_LEGACY_PROTOCOL_VERSION } from "#internal/mcp/streamable-http-server.js";
import { none, oauthResource } from "#public/channels/auth.js";
import type { Agent } from "#public/definitions/channel.js";
import { mcpChannel } from "#public/channels/mcp.js";

const principal: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  principalId: "user-1",
  principalType: "user",
};

describe("mcpChannel", () => {
  it("fails closed when auth is omitted", () => {
    expect(() => mcpChannel({} as never)).toThrow(
      "mcpChannel requires auth. Use none() for explicit public access.",
    );
  });

  it("publishes task-mode durable invocation compatibility tools", async () => {
    const channel = mcpChannel({ auth: none() });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /mcp",
      "POST /mcp",
      "DELETE /mcp",
    ]);
    const postRoute = channel.routes[1]!;
    if (postRoute.transport === "websocket") throw new Error("expected HTTP route");

    const initialize = await postRoute.handler(
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
          protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
        },
      }),
      routeArgs(),
    );
    await expect(jsonRpcResponse(initialize)).resolves.toMatchObject({
      result: { serverInfo: { name: "compiled-agent" } },
    });

    const tools = await postRoute.handler(
      mcpRequest({ id: 2, jsonrpc: "2.0", method: "tools/list" }),
      routeArgs(),
    );
    const body = (await jsonRpcResponse(tools)) as {
      result: { tools: { description?: string; name: string }[] };
    };
    expect(body.result.tools.map((tool) => tool.name)).toEqual([
      "agent_start",
      "agent_get",
      "agent_update",
      "agent_cancel",
    ]);
    expect(body.result.tools[0]).toMatchObject({
      description: expect.stringContaining("Investigates tasks."),
    });
  });

  it("uses existing eve auth strategies directly", async () => {
    const channel = mcpChannel({ auth: () => principal });
    const route = channel.routes[1]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");

    const response = await route.handler(
      mcpRequest({
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "test-client", version: "0.0.0" },
          protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
        },
      }),
      routeArgs(),
    );
    expect(response.status).toBe(200);
  });

  it("mounts OAuth resource metadata and augments auth failures", async () => {
    const channel = mcpChannel({
      auth: oauthResource(() => null, {
        issuer: "https://issuer.example",
        resource: "https://agent.example/delegate",
        scopes: ["agent:invoke"],
      }),
      path: "/delegate",
    });
    expect(channel.routes.map((route) => `${route.method} ${route.path}`)).toEqual([
      "GET /.well-known/oauth-protected-resource",
      "GET /delegate",
      "POST /delegate",
      "DELETE /delegate",
    ]);

    const metadataRoute = channel.routes[0]!;
    if (metadataRoute.transport === "websocket") throw new Error("expected HTTP route");
    const metadata = await metadataRoute.handler(
      new Request("https://private.example/.well-known/oauth-protected-resource"),
      {} as never,
    );
    await expect(metadata.json()).resolves.toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/delegate",
      scopes_supported: ["agent:invoke"],
    });

    const route = channel.routes[2]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      new Request("https://private.example/delegate", { method: "POST" }),
      {} as never,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://agent.example/.well-known/oauth-protected-resource"',
    );
    expect(response.headers.get("www-authenticate")).toContain('scope="agent:invoke"');
  });

  it("derives the protected resource from the public request origin", async () => {
    const channel = mcpChannel({
      auth: oauthResource(() => null, { issuer: "https://issuer.example" }),
      path: "/delegate",
    });
    const route = channel.routes[0]!;
    if (route.transport === "websocket") throw new Error("expected HTTP route");
    const response = await route.handler(
      new Request("https://agent.example/.well-known/oauth-protected-resource"),
      {} as never,
    );
    await expect(response.json()).resolves.toEqual({
      authorization_servers: ["https://issuer.example"],
      resource: "https://agent.example/delegate",
    });
  });
});

function routeArgs(): RouteHandlerArgs {
  return attachAgentInfoRouteResponse(
    attachRouteAgent({} as RouteHandlerArgs, {} as Agent),
    async () =>
      Response.json({
        agent: {
          description: "Investigates tasks.",
          name: "compiled-agent",
        },
      }),
  );
}

function mcpRequest(body: unknown): Request {
  return new Request("https://agent.example/mcp", {
    body: JSON.stringify(body),
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    method: "POST",
  });
}

async function jsonRpcResponse(response: Response): Promise<unknown> {
  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    return await response.json();
  }
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  if (data === undefined) throw new Error("MCP SSE response did not contain a data event.");
  return JSON.parse(data.slice("data: ".length));
}
