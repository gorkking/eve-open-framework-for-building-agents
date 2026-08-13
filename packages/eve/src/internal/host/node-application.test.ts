import { beforeEach, describe, expect, it, vi } from "vitest";

const nodeServerMocks = vi.hoisted(() => ({
  serve: vi.fn(),
}));

const scheduleMocks = vi.hoisted(() => ({
  close: vi.fn<() => Promise<void>>(),
  startLocalScheduleRunner: vi.fn(),
}));

vi.mock("#compiled/crossws/node.js", () => ({ serve: nodeServerMocks.serve }));
vi.mock("#internal/host/schedule-runtime.js", () => ({
  startLocalScheduleRunner: scheduleMocks.startLocalScheduleRunner,
}));

import { ApplicationLifecycle } from "#internal/host/application-lifecycle.js";
import { startNodeApplication } from "#internal/host/node-application.js";

describe("startNodeApplication", () => {
  beforeEach(() => {
    nodeServerMocks.serve.mockReset();
    scheduleMocks.close.mockReset().mockResolvedValue(undefined);
    scheduleMocks.startLocalScheduleRunner.mockReset().mockReturnValue({
      close: scheduleMocks.close,
      runCron: vi.fn(),
      runTask: vi.fn(),
    });
  });

  it("starts CrossWS manually and returns only after the server is ready", async () => {
    const ready = deferred<void>();
    const server = createServer({ ready: () => ready.promise });
    nodeServerMocks.serve.mockReturnValue(server);
    const fetch = vi.fn(async () => new Response("ok"));
    const lifecycle = new ApplicationLifecycle();

    const starting = startNodeApplication({
      fetch,
      hostname: "127.0.0.1",
      lifecycle,
      port: 4_321,
      silent: true,
      websocket: true,
    });

    await Promise.resolve();
    expect(server.serve).toHaveBeenCalledOnce();
    expect(nodeServerMocks.serve).toHaveBeenCalledWith({
      fetch: expect.any(Function),
      gracefulShutdown: false,
      hostname: "127.0.0.1",
      manual: true,
      port: 4_321,
      silent: true,
      websocket: { resolve: expect.any(Function) },
    });

    let settled = false;
    void starting.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    ready.resolve();
    const application = await starting;
    expect(application.url).toBe("http://127.0.0.1:4321");
    expect(application.waitUntil).toEqual(expect.any(Function));
    expect(application.waitUntil).not.toBe(server.waitUntil);
    await application.close();
  });

  it("starts schedules after readiness and registers their work with the server", async () => {
    const ready = deferred<void>();
    const server = createServer({ ready: () => ready.promise });
    nodeServerMocks.serve.mockReturnValue(server);
    const scheduleRuntimeOptions = {
      artifactsConfig: { kind: "production" as const },
      environment: {},
      scheduleRegistrations: [],
    };

    const starting = startNodeApplication({
      fetch: async () => new Response(),
      lifecycle: new ApplicationLifecycle(),
      scheduleRuntimeOptions,
    });
    await Promise.resolve();

    expect(scheduleMocks.startLocalScheduleRunner).not.toHaveBeenCalled();
    ready.resolve();
    const application = await starting;

    expect(scheduleMocks.startLocalScheduleRunner).toHaveBeenCalledWith({
      ...scheduleRuntimeOptions,
      waitUntil: application.waitUntil,
    });
    await application.close();
  });

  it("closes schedules, transport, and lifecycle once in dependency order", async () => {
    const calls: string[] = [];
    const server = createServer({
      close: async (closeActiveConnections) => {
        expect(closeActiveConnections).toBe(true);
        calls.push("server");
      },
    });
    scheduleMocks.close.mockImplementation(async () => {
      calls.push("schedules");
    });
    nodeServerMocks.serve.mockReturnValue(server);
    const lifecycle = new ApplicationLifecycle();
    lifecycle.onClose(() => calls.push("lifecycle"));
    const application = await startNodeApplication({
      fetch: async () => new Response(),
      lifecycle,
      scheduleRuntimeOptions: {
        artifactsConfig: { kind: "production" },
        environment: {},
        scheduleRegistrations: [],
      },
    });

    await Promise.all([application.close(), application.close()]);

    expect(calls).toEqual(["schedules", "server", "lifecycle"]);
    expect(scheduleMocks.close).toHaveBeenCalledOnce();
    expect(server.close).toHaveBeenCalledOnce();
  });

  it("drains eve-owned background work after transport shutdown and before lifecycle close", async () => {
    const calls: string[] = [];
    const background = deferred<void>();
    const server = createServer({
      close: async () => {
        calls.push("server");
      },
    });
    nodeServerMocks.serve.mockReturnValue(server);
    const lifecycle = new ApplicationLifecycle();
    lifecycle.onClose(() => calls.push("lifecycle"));
    const application = await startNodeApplication({
      fetch: async () => new Response(),
      lifecycle,
    });
    application.waitUntil?.(background.promise);

    const closing = application.close();
    await Promise.resolve();

    expect(calls).toEqual(["server"]);
    background.resolve();
    await closing;
    expect(calls).toEqual(["server", "lifecycle"]);
  });

  it("drains an admitted handler and waitUntil work registered after transport close", async () => {
    const calls: string[] = [];
    const handlerStarted = deferred<void>();
    const registerBackground = deferred<void>();
    const backgroundRegistered = deferred<void>();
    const background = deferred<void>();
    const finishHandler = deferred<void>();
    const releaseServerClose = deferred<void>();
    const serverCloseStarted = deferred<void>();
    const server = createServer({
      close: async () => {
        calls.push("server-close-started");
        serverCloseStarted.resolve();
        await releaseServerClose.promise;
        calls.push("server-close-settled");
      },
    });
    nodeServerMocks.serve.mockReturnValue(server);
    const lifecycle = new ApplicationLifecycle();
    lifecycle.onClose(() => calls.push("lifecycle"));
    const application = await startNodeApplication({
      fetch: async (request) => {
        handlerStarted.resolve();
        await registerBackground.promise;
        (request as Request & { waitUntil: (task: Promise<unknown>) => void }).waitUntil(
          background.promise.then(() => {
            calls.push("background");
          }),
        );
        calls.push("background-registered");
        backgroundRegistered.resolve();
        await finishHandler.promise;
        calls.push("handler");
        return new Response("ok");
      },
      lifecycle,
    });
    const serverOptions = nodeServerMocks.serve.mock.calls[0]?.[0];
    expect(serverOptions).toBeDefined();
    const serverFetch = (
      serverOptions as {
        fetch: (request: Request) => Promise<Response>;
      }
    ).fetch;
    const responsePromise = serverFetch(new Request("https://example.com/"));
    await handlerStarted.promise;

    const closing = application.close();
    await serverCloseStarted.promise;
    releaseServerClose.resolve();
    await (server.close.mock.results[0]?.value as Promise<void>);

    registerBackground.resolve();
    await backgroundRegistered.promise;
    expect(calls).toEqual([
      "server-close-started",
      "server-close-settled",
      "background-registered",
    ]);

    background.resolve();
    await Promise.resolve();
    expect(calls).toContain("background");
    expect(calls).not.toContain("lifecycle");

    finishHandler.resolve();
    await expect(responsePromise).resolves.toBeInstanceOf(Response);
    await closing;
    expect(calls).toEqual([
      "server-close-started",
      "server-close-settled",
      "background-registered",
      "background",
      "handler",
      "lifecycle",
    ]);
  });

  it("settles every close phase and aggregates failures", async () => {
    const lifecycleClosed = vi.fn();
    const server = createServer({
      close: async () => {
        throw new Error("server close failed");
      },
    });
    scheduleMocks.close.mockRejectedValue(new Error("schedule close failed"));
    nodeServerMocks.serve.mockReturnValue(server);
    const lifecycle = new ApplicationLifecycle();
    lifecycle.onClose(lifecycleClosed);
    const application = await startNodeApplication({
      fetch: async () => new Response(),
      lifecycle,
      scheduleRuntimeOptions: {
        artifactsConfig: { kind: "production" },
        environment: {},
        scheduleRegistrations: [],
      },
    });

    await expect(application.close()).rejects.toMatchObject({
      errors: [
        expect.objectContaining({ message: "schedule close failed" }),
        expect.objectContaining({ message: "server close failed" }),
      ],
    });
    expect(lifecycleClosed).toHaveBeenCalledOnce();
  });

  it("cleans up the server and lifecycle when startup fails", async () => {
    const lifecycleClosed = vi.fn();
    const server = createServer({
      ready: async () => {
        throw new Error("listen failed");
      },
    });
    nodeServerMocks.serve.mockReturnValue(server);
    const lifecycle = new ApplicationLifecycle();
    lifecycle.onClose(lifecycleClosed);

    await expect(
      startNodeApplication({ fetch: async () => new Response(), lifecycle }),
    ).rejects.toThrow("listen failed");
    expect(server.close).toHaveBeenCalledWith(true);
    expect(lifecycleClosed).toHaveBeenCalledOnce();
    expect(scheduleMocks.startLocalScheduleRunner).not.toHaveBeenCalled();
  });

  it("does not enable WebSockets or schedules unless requested", async () => {
    const server = createServer();
    nodeServerMocks.serve.mockReturnValue(server);
    const application = await startNodeApplication({
      fetch: async () => new Response(),
      lifecycle: new ApplicationLifecycle(),
    });

    expect(nodeServerMocks.serve).toHaveBeenCalledWith(
      expect.objectContaining({ websocket: undefined }),
    );
    expect(scheduleMocks.startLocalScheduleRunner).not.toHaveBeenCalled();
    await application.close();
  });
});

function createServer(input?: {
  readonly close?: (closeActiveConnections?: boolean) => Promise<void>;
  readonly ready?: () => Promise<void>;
}) {
  const waitUntil = vi.fn<(task: Promise<unknown>) => void>();
  return {
    close: vi.fn(input?.close ?? (async () => undefined)),
    ready: vi.fn(input?.ready ?? (async () => undefined)),
    serve: vi.fn(),
    url: "http://127.0.0.1:4321",
    waitUntil,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}
