import { afterEach, describe, expect, it, vi } from "vitest";

import type { RouteHandlerArgs } from "#channel/routes.js";
import type { Session } from "#channel/session.js";
import { startRemoteAgentSession } from "#execution/remote-agent-dispatch.js";
import {
  attachRouteSessionCreator,
  type RouteSessionCreator,
} from "#internal/nitro/routes/channel-route-context.js";
import { mockChannelContext } from "#internal/testing/mocks/mock-channel-operations.js";
import { none } from "#public/channels/auth.js";
import { eveChannel } from "#public/channels/eve.js";
import type { RuntimeRemoteAgentCallActionRequest } from "#runtime/actions/types.js";
import type { ResolvedRuntimeRemoteAgentNode } from "#runtime/types.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("remote agent dispatch to eveChannel", () => {
  it("admits and replays an authless remote create through its callback capability", async () => {
    const channel = eveChannel({ auth: none() });
    const createRoute = channel.routes.find(
      (route) => route.method === "POST" && route.path === "/eve/v1/session",
    );
    if (createRoute === undefined) throw new Error("No create-session route found.");

    let ownerSessionId: string | undefined;
    const resolveSession = vi.fn<RouteHandlerArgs["resolveSession"]>(async () =>
      ownerSessionId === undefined ? undefined : ({ id: ownerSessionId } as Session),
    );
    const createSession = vi.fn<RouteSessionCreator>(async () => {
      ownerSessionId = "remote-session";
      return { events: new ReadableStream(), sessionId: ownerSessionId };
    });
    const routeArgs = attachRouteSessionCreator(
      {
        ...mockChannelContext(() => undefined),
        attachSession: vi.fn() as never,
        params: {},
        requestIp: "127.0.0.1",
        resolveSession,
        to: vi.fn() as never,
        waitUntil: () => undefined,
      },
      createSession,
    );
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) =>
      createRoute.handler(new Request(url, init), routeArgs),
    );
    vi.stubGlobal("fetch", fetchMock);

    const input: Parameters<typeof startRemoteAgentSession>[0] = {
      action: createAction(),
      callbackBaseUrl: "https://caller.example.com",
      operationId: "operation-1",
      remote: createRemoteAgent(),
      session: {
        agent: { modelReference: { id: "mock/test" }, system: "", tools: [] },
        compaction: { recentWindowSize: 10, threshold: 100_000 },
        continuationToken: "callback-capability",
        history: [],
        sessionId: "parent-session",
        state: {},
      },
    };

    await expect(startRemoteAgentSession(input)).resolves.toEqual({
      sessionId: "remote-session",
    });
    await expect(startRemoteAgentSession(input)).resolves.toEqual({
      sessionId: "remote-session",
    });

    expect(createSession).toHaveBeenCalledOnce();
    expect(resolveSession).toHaveBeenCalledTimes(2);
    expect(createSession.mock.calls[0]?.[0]).toMatchObject({
      callback: { token: "callback-capability" },
      continuationToken: expect.stringMatching(/^eve:op:[0-9a-f]{32}$/),
    });
    expect(fetchMock.mock.calls[0]?.[1]?.headers).not.toHaveProperty("authorization");
  });
});

function createAction(): RuntimeRemoteAgentCallActionRequest {
  return {
    callId: "call-remote",
    description: "Runtime action event description.",
    input: { message: "find the marker" },
    kind: "remote-agent-call",
    name: "research",
    nodeId: "subagents/research.ts",
    remoteAgentName: "research",
  };
}

function createRemoteAgent(): ResolvedRuntimeRemoteAgentNode {
  return {
    description: "Performs research.",
    kind: "remote",
    logicalPath: "subagents/research.ts",
    name: "research",
    nodeId: "subagents/research.ts",
    path: "/eve/v1/session",
    sourceId: "subagents/research.ts",
    sourceKind: "module",
    url: "https://remote.example.com",
  };
}
