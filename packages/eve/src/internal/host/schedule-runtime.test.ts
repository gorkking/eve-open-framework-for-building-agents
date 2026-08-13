import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ScheduleRegistration } from "#runtime/schedules/register.js";

const dispatchMocks = vi.hoisted(() => ({
  dispatchScheduleTask: vi.fn(),
}));

const cronMocks = vi.hoisted(() => ({
  jobs: [] as Array<{
    callback: () => Promise<void>;
    options: Record<string, unknown>;
    pattern: string;
    stop: ReturnType<typeof vi.fn>;
  }>,
  throwForPattern: undefined as string | undefined,
}));

vi.mock("#internal/host/routes/schedule-task.js", () => dispatchMocks);
vi.mock("croner", () => ({
  Cron: class MockCron {
    readonly stop = vi.fn();

    constructor(pattern: string, options: Record<string, unknown>, callback: () => Promise<void>) {
      if (pattern === cronMocks.throwForPattern) {
        throw new Error(`Invalid cron: ${pattern}`);
      }
      cronMocks.jobs.push({ callback, options, pattern, stop: this.stop });
    }
  },
}));

import {
  createScheduleRuntime,
  startLocalScheduleRunner,
  UnknownScheduleTaskError,
} from "#internal/host/schedule-runtime.js";

const artifactsConfig = { kind: "production" } as const;

describe("createScheduleRuntime", () => {
  beforeEach(() => {
    dispatchMocks.dispatchScheduleTask.mockReset();
    cronMocks.jobs.length = 0;
    cronMocks.throwForPattern = undefined;
  });

  it("dispatches every task registered for a cron expression", async () => {
    const registrations = [
      createRegistration("task-a", "0 * * * *"),
      createRegistration("task-b", "0 * * * *"),
      createRegistration("task-c", "30 * * * *"),
    ];
    dispatchMocks.dispatchScheduleTask.mockImplementation(async (taskName: string) => ({
      scheduleId: taskName,
      sessionIds: [`session-${taskName}`],
    }));

    const runtime = createScheduleRuntime({
      artifactsConfig,
      scheduleRegistrations: registrations,
    });
    const results = await runtime.runCron("0 * * * *");

    expect(dispatchMocks.dispatchScheduleTask).toHaveBeenCalledTimes(2);
    expect(dispatchMocks.dispatchScheduleTask).toHaveBeenNthCalledWith(
      1,
      "task-a",
      artifactsConfig,
    );
    expect(dispatchMocks.dispatchScheduleTask).toHaveBeenNthCalledWith(
      2,
      "task-b",
      artifactsConfig,
    );
    expect(results).toEqual([
      { scheduleId: "task-a", sessionIds: ["session-task-a"] },
      { scheduleId: "task-b", sessionIds: ["session-task-b"] },
    ]);
  });

  it("returns an empty result for an unregistered cron expression", async () => {
    const runtime = createScheduleRuntime({
      artifactsConfig,
      scheduleRegistrations: [createRegistration("task-a", "0 * * * *")],
    });

    await expect(runtime.runCron("15 * * * *")).resolves.toEqual([]);
    expect(dispatchMocks.dispatchScheduleTask).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent runs of the same task", async () => {
    const result = deferred<{ scheduleId: string; sessionIds: readonly string[] }>();
    dispatchMocks.dispatchScheduleTask.mockReturnValueOnce(result.promise).mockResolvedValueOnce({
      scheduleId: "schedule-a",
      sessionIds: ["session-next"],
    });
    const runtime = createScheduleRuntime({
      artifactsConfig,
      scheduleRegistrations: [createRegistration("task-a", "0 * * * *")],
    });

    const first = runtime.runTask("task-a");
    const second = runtime.runTask("task-a");
    await Promise.resolve();

    expect(dispatchMocks.dispatchScheduleTask).toHaveBeenCalledTimes(1);
    result.resolve({ scheduleId: "schedule-a", sessionIds: ["session-a"] });
    await expect(Promise.all([first, second])).resolves.toEqual([
      { scheduleId: "schedule-a", sessionIds: ["session-a"] },
      { scheduleId: "schedule-a", sessionIds: ["session-a"] },
    ]);

    await expect(runtime.runTask("task-a")).resolves.toEqual({
      scheduleId: "schedule-a",
      sessionIds: ["session-next"],
    });
    expect(dispatchMocks.dispatchScheduleTask).toHaveBeenCalledTimes(2);
  });

  it("clears a failed task from the in-flight registry", async () => {
    dispatchMocks.dispatchScheduleTask
      .mockRejectedValueOnce(new Error("first run failed"))
      .mockResolvedValueOnce({ scheduleId: "schedule-a", sessionIds: [] });
    const runtime = createScheduleRuntime({
      artifactsConfig,
      scheduleRegistrations: [createRegistration("task-a", "0 * * * *")],
    });

    await expect(runtime.runTask("task-a")).rejects.toThrow("first run failed");
    await expect(runtime.runTask("task-a")).resolves.toEqual({
      scheduleId: "schedule-a",
      sessionIds: [],
    });
    expect(dispatchMocks.dispatchScheduleTask).toHaveBeenCalledTimes(2);
  });

  it("rejects an unregistered task without dispatching it", async () => {
    const runtime = createScheduleRuntime({ artifactsConfig, scheduleRegistrations: [] });

    await expect(runtime.runTask("missing-task")).rejects.toEqual(
      expect.objectContaining<Partial<UnknownScheduleTaskError>>({
        message: 'Schedule task "missing-task" is not registered.',
        name: "UnknownScheduleTaskError",
        taskName: "missing-task",
      }),
    );
    expect(dispatchMocks.dispatchScheduleTask).not.toHaveBeenCalled();
  });
});

describe("startLocalScheduleRunner", () => {
  beforeEach(() => {
    dispatchMocks.dispatchScheduleTask.mockReset();
    cronMocks.jobs.length = 0;
    cronMocks.throwForPattern = undefined;
  });

  it("starts one unreferenced Croner job per cron expression", async () => {
    dispatchMocks.dispatchScheduleTask.mockImplementation(async (taskName: string) => ({
      scheduleId: taskName,
      sessionIds: [],
    }));
    const runner = startLocalScheduleRunner({
      artifactsConfig,
      environment: {},
      scheduleRegistrations: [
        createRegistration("task-a", "0 * * * *"),
        createRegistration("task-b", "0 * * * *"),
        createRegistration("task-c", "30 * * * *"),
      ],
    });

    expect(cronMocks.jobs.map(({ options, pattern }) => ({ options, pattern }))).toEqual([
      { options: { unref: true }, pattern: "0 * * * *" },
      { options: { unref: true }, pattern: "30 * * * *" },
    ]);

    await cronMocks.jobs[0]!.callback();
    expect(dispatchMocks.dispatchScheduleTask.mock.calls.map(([taskName]) => taskName)).toEqual([
      "task-a",
      "task-b",
    ]);
    await runner.close();
  });

  it("reports scheduled dispatch failures without rejecting the Croner callback", async () => {
    const onError = vi.fn();
    dispatchMocks.dispatchScheduleTask.mockRejectedValue(new Error("dispatch failed"));
    const runner = startLocalScheduleRunner({
      artifactsConfig,
      environment: {},
      onError,
      scheduleRegistrations: [createRegistration("task-a", "0 * * * *")],
    });

    await expect(cronMocks.jobs[0]!.callback()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "dispatch failed" }),
      "0 * * * *",
    );
    await runner.close();
  });

  it("registers scheduled dispatches as host background work", async () => {
    const waitUntil = vi.fn<(task: Promise<unknown>) => void>();
    dispatchMocks.dispatchScheduleTask.mockResolvedValue({
      scheduleId: "schedule-a",
      sessionIds: [],
    });
    const runner = startLocalScheduleRunner({
      artifactsConfig,
      environment: {},
      scheduleRegistrations: [createRegistration("task-a", "0 * * * *")],
      waitUntil,
    });

    const callback = cronMocks.jobs[0]!.callback();

    expect(waitUntil).toHaveBeenCalledOnce();
    expect(waitUntil).toHaveBeenCalledWith(expect.any(Promise));
    await callback;
    await runner.close();
  });

  it("stops every Croner job exactly once", async () => {
    const runner = startLocalScheduleRunner({
      artifactsConfig,
      environment: {},
      scheduleRegistrations: [
        createRegistration("task-a", "0 * * * *"),
        createRegistration("task-b", "30 * * * *"),
      ],
    });

    await runner.close();
    await runner.close();

    expect(cronMocks.jobs).toHaveLength(2);
    for (const job of cronMocks.jobs) {
      expect(job.stop).toHaveBeenCalledTimes(1);
    }
  });

  it("does not create local timers in a test process", async () => {
    const runner = startLocalScheduleRunner({
      artifactsConfig,
      environment: { TEST: "1" },
      scheduleRegistrations: [createRegistration("task-a", "0 * * * *")],
    });

    expect(cronMocks.jobs).toEqual([]);
    await runner.close();
  });

  it("does create local timers when TEST is empty", async () => {
    const runner = startLocalScheduleRunner({
      artifactsConfig,
      environment: { TEST: "" },
      scheduleRegistrations: [createRegistration("task-a", "0 * * * *")],
    });

    expect(cronMocks.jobs).toHaveLength(1);
    await runner.close();
  });

  it("stops timers already created when a later Croner job is invalid", () => {
    cronMocks.throwForPattern = "invalid";

    expect(() =>
      startLocalScheduleRunner({
        artifactsConfig,
        environment: {},
        scheduleRegistrations: [
          createRegistration("task-a", "0 * * * *"),
          createRegistration("task-b", "invalid"),
        ],
      }),
    ).toThrow("Invalid cron: invalid");
    expect(cronMocks.jobs).toHaveLength(1);
    expect(cronMocks.jobs[0]!.stop).toHaveBeenCalledOnce();
  });
});

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
