import { defineWebSocketHandler, H3 } from "h3";
import { describe, expect, it } from "vitest";

import { ApplicationLifecycle } from "#internal/host/application-lifecycle.js";
import { startNodeApplication } from "#internal/host/node-application.js";

describe("startNodeApplication WebSockets", () => {
  it("serves a real CrossWS upgrade through the Node transport", async () => {
    const app = new H3().all(
      "/socket",
      defineWebSocketHandler(() => ({
        message(peer, message) {
          peer.send(`echo:${message.text()}`);
        },
      })),
    );
    const server = await startNodeApplication({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      lifecycle: new ApplicationLifecycle(),
      port: 0,
      silent: true,
      websocket: true,
    });

    try {
      expect(server.url).toBeDefined();
      const socketUrl = new URL("/socket", server.url);
      socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(socketUrl);
      await waitForSocketOpen(socket);
      socket.send("hello");
      await expect(waitForSocketMessage(socket)).resolves.toBe("echo:hello");
      socket.close();
    } finally {
      await server.close();
    }
  });

  it("rejects upgrades on successful routes without WebSocket hooks", async () => {
    const app = new H3()
      .get("/ordinary", () => new Response("ordinary"))
      .all("/socket", defineWebSocketHandler({ open() {} }));
    const server = await startNodeApplication({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      lifecycle: new ApplicationLifecycle(),
      port: 0,
      silent: true,
      websocket: true,
    });

    try {
      await expect(openWebSocket(server.url, "/ordinary")).rejects.toThrow(
        "WebSocket failed to open.",
      );
    } finally {
      await server.close();
    }
  });

  it("serves HTTP GET and a real WebSocket upgrade on the same route", async () => {
    const app = new H3().get(
      "/shared",
      defineWebSocketHandler(
        {
          message(peer, message) {
            peer.send(`echo:${message.text()}`);
          },
        },
        () => new Response("http response"),
      ),
    );
    const server = await startNodeApplication({
      fetch: app.fetch,
      hostname: "127.0.0.1",
      lifecycle: new ApplicationLifecycle(),
      port: 0,
      silent: true,
      websocket: true,
    });

    try {
      const response = await fetch(new URL("/shared", server.url));
      await expect(response.text()).resolves.toBe("http response");

      const socket = await openWebSocket(server.url, "/shared");
      socket.send("hello");
      await expect(waitForSocketMessage(socket)).resolves.toBe("echo:hello");
      socket.close();
    } finally {
      await server.close();
    }
  });
});

async function openWebSocket(serverUrl: string | undefined, pathname: string): Promise<WebSocket> {
  const socketUrl = new URL(pathname, serverUrl);
  socketUrl.protocol = socketUrl.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(socketUrl);
  await waitForSocketOpen(socket);
  return socket;
}

async function waitForSocketOpen(socket: WebSocket): Promise<void> {
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket failed to open.")), {
        once: true,
      });
    }),
  );
}

async function waitForSocketMessage(socket: WebSocket): Promise<string> {
  return await withTimeout(
    new Promise<string>((resolve, reject) => {
      socket.addEventListener("message", (event) => resolve(String(event.data)), { once: true });
      socket.addEventListener("error", () => reject(new Error("WebSocket message failed.")), {
        once: true,
      });
    }),
  );
}

async function withTimeout<T>(operation: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("WebSocket operation timed out.")), 5_000);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}
