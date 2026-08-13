import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";

const dispatchMocks = vi.hoisted(() => ({
  dispatchScheduleTask: vi.fn(),
}));

vi.mock("#internal/host/routes/schedule-task.js", () => dispatchMocks);

import {
  createVercelCronHandler,
  createVercelCronHandlerRoute,
} from "#internal/host/vercel-cron-handler.js";

const artifactsConfig = { kind: "production" } as const;
const CRON = "0 * * * *";

describe("createVercelCronHandlerRoute", () => {
  it("creates an unguessable route under the eve protocol prefix", () => {
    expect(createVercelCronHandlerRoute()).toMatch(
      new RegExp(`^${EVE_ROUTE_PREFIX.replaceAll("/", "\\/")}\\/cron\\/[A-Za-z0-9_-]{43}$`),
    );
  });

  it("creates a fresh route for every build", () => {
    const routes = new Set(Array.from({ length: 100 }, createVercelCronHandlerRoute));
    expect(routes).toHaveLength(100);
  });
});

describe("createVercelCronHandler", () => {
  beforeEach(() => {
    dispatchMocks.dispatchScheduleTask.mockReset();
  });

  it("dispatches every task matching the Vercel cron header", async () => {
    dispatchMocks.dispatchScheduleTask.mockImplementation(async (taskName: string) => ({
      scheduleId: taskName,
      sessionIds: [],
    }));
    const handler = createHandler({
      scheduleRegistrations: [
        createRegistration("task-a", CRON),
        createRegistration("task-b", CRON),
        createRegistration("task-c", "30 * * * *"),
      ],
    });

    const response = await handler(createRequest({ "x-vercel-cron-schedule": CRON }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(dispatchMocks.dispatchScheduleTask.mock.calls).toEqual([
      ["task-a", artifactsConfig],
      ["task-b", artifactsConfig],
    ]);
  });

  it("requires the Vercel cron schedule header", async () => {
    const handler = createHandler();

    const response = await handler(createRequest());

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: true,
      message: "Missing x-vercel-cron-schedule header",
      status: 400,
      statusText: "",
    });
    expect(dispatchMocks.dispatchScheduleTask).not.toHaveBeenCalled();
  });

  it("allows requests without authorization when CRON_SECRET is not configured", async () => {
    const handler = createHandler({ environment: {} });

    const response = await handler(
      createRequest({ authorization: "Bearer ignored", "x-vercel-cron-schedule": CRON }),
    );

    expect(response.status).toBe(200);
  });

  it("requires an exact Bearer token when CRON_SECRET is configured", async () => {
    const handler = createHandler({ environment: { CRON_SECRET: "schedule-secret" } });

    for (const authorization of [
      undefined,
      "schedule-secret",
      "bearer schedule-secret",
      "Bearer schedule-secreu",
      "Bearer wrong-length",
    ]) {
      const response = await handler(
        createRequest({ authorization, "x-vercel-cron-schedule": CRON }),
      );
      expect(response.status).toBe(401);
      await expect(response.json()).resolves.toEqual({
        error: true,
        message: "Unauthorized",
        status: 401,
        statusText: "",
      });
    }

    expect(dispatchMocks.dispatchScheduleTask).not.toHaveBeenCalled();
    const authorized = await handler(
      createRequest({
        authorization: "Bearer schedule-secret",
        "x-vercel-cron-schedule": CRON,
      }),
    );
    expect(authorized.status).toBe(200);
  });

  it("returns success when no task matches the cron expression", async () => {
    const handler = createHandler({
      scheduleRegistrations: [createRegistration("task-a", CRON)],
    });

    const response = await handler(createRequest({ "x-vercel-cron-schedule": "15 * * * *" }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ success: true });
    expect(dispatchMocks.dispatchScheduleTask).not.toHaveBeenCalled();
  });

  it("deduplicates the same task across concurrent cron requests", async () => {
    const task = deferred<{ scheduleId: string; sessionIds: readonly string[] }>();
    dispatchMocks.dispatchScheduleTask.mockReturnValue(task.promise);
    const handler = createHandler({
      scheduleRegistrations: [createRegistration("task-a", CRON)],
    });
    const request = () => createRequest({ "x-vercel-cron-schedule": CRON });

    const first = handler(request());
    const second = handler(request());
    await Promise.resolve();

    expect(dispatchMocks.dispatchScheduleTask).toHaveBeenCalledTimes(1);
    task.resolve({ scheduleId: "schedule-a", sessionIds: [] });
    const responses = await Promise.all([first, second]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
  });

  it("propagates schedule dispatch failures", async () => {
    dispatchMocks.dispatchScheduleTask.mockRejectedValue(new Error("dispatch failed"));
    const handler = createHandler({
      scheduleRegistrations: [createRegistration("task-a", CRON)],
    });

    await expect(handler(createRequest({ "x-vercel-cron-schedule": CRON }))).rejects.toThrow(
      "dispatch failed",
    );
  });
});

function createHandler(
  input: {
    environment?: Readonly<Record<string, string | undefined>>;
    scheduleRegistrations?: readonly ScheduleRegistration[];
  } = {},
) {
  return createVercelCronHandler({
    artifactsConfig,
    environment: input.environment ?? {},
    scheduleRegistrations: input.scheduleRegistrations ?? [],
  });
}

function createRegistration(taskName: string, cron: string): ScheduleRegistration {
  return {
    cron,
    description: `Run ${taskName}`,
    logicalPath: `agent/schedules/${taskName}.ts`,
    scheduleId: taskName,
    sourceId: `source:${taskName}`,
    taskName,
  };
}

function createRequest(headers: Record<string, string | undefined> = {}): Request {
  return new Request("https://agent.example/eve/v1/cron/secret", {
    headers: Object.fromEntries(
      Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== undefined),
    ),
    method: "POST",
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolvePromise: ((value: T) => void) | undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      resolvePromise?.(value);
    },
  };
}
