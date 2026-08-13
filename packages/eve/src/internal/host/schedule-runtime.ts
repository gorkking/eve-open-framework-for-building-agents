import { Cron } from "#compiled/croner/index.js";

import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import { dispatchScheduleTask } from "#internal/host/routes/schedule-task.js";

export type ProductionScheduleArtifactsConfig = Extract<
  Parameters<typeof dispatchScheduleTask>[1],
  { readonly kind: "production" }
>;

export type ScheduleTaskResult = Awaited<ReturnType<typeof dispatchScheduleTask>>;

export interface ScheduleRuntimeOptions {
  readonly artifactsConfig: ProductionScheduleArtifactsConfig;
  readonly scheduleRegistrations: readonly ScheduleRegistration[];
}

export interface ScheduleRuntime {
  runCron(cron: string): Promise<readonly ScheduleTaskResult[]>;
  runTask(taskName: string): Promise<ScheduleTaskResult>;
}

export interface LocalScheduleRunner extends ScheduleRuntime {
  close(): Promise<void>;
}

export interface LocalScheduleRunnerOptions extends ScheduleRuntimeOptions {
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly onError?: (error: unknown, cron: string) => void;
  readonly waitUntil?: (task: Promise<unknown>) => void;
}

export class UnknownScheduleTaskError extends Error {
  readonly taskName: string;

  constructor(taskName: string) {
    super(`Schedule task "${taskName}" is not registered.`);
    this.name = "UnknownScheduleTaskError";
    this.taskName = taskName;
  }
}

export function createScheduleRuntime(input: ScheduleRuntimeOptions): ScheduleRuntime {
  const taskNames = new Set(
    input.scheduleRegistrations.map((registration) => registration.taskName),
  );
  const taskNamesByCron = indexTaskNamesByCron(input.scheduleRegistrations);
  const runningTasks = new Map<string, Promise<ScheduleTaskResult>>();

  const runTask = (taskName: string): Promise<ScheduleTaskResult> => {
    if (!taskNames.has(taskName)) {
      return Promise.reject(new UnknownScheduleTaskError(taskName));
    }

    const running = runningTasks.get(taskName);
    if (running !== undefined) {
      return running;
    }

    const task = Promise.resolve().then(
      async () => await dispatchScheduleTask(taskName, input.artifactsConfig),
    );
    runningTasks.set(taskName, task);
    const clearRunningTask = () => {
      if (runningTasks.get(taskName) === task) {
        runningTasks.delete(taskName);
      }
    };
    void task.then(clearRunningTask, clearRunningTask);
    return task;
  };

  return {
    async runCron(cron) {
      return await Promise.all((taskNamesByCron.get(cron) ?? []).map(runTask));
    },
    runTask,
  };
}

export function startLocalScheduleRunner(input: LocalScheduleRunnerOptions): LocalScheduleRunner {
  const runtime = createScheduleRuntime(input);
  const jobs: Cron[] = [];
  let closed = false;

  if (input.scheduleRegistrations.length > 0 && !(input.environment ?? process.env).TEST) {
    const cronExpressions = [...indexTaskNamesByCron(input.scheduleRegistrations).keys()];
    try {
      for (const cron of cronExpressions) {
        jobs.push(
          new Cron(cron, { unref: true }, async () => {
            const task = runtime.runCron(cron);
            input.waitUntil?.(task);
            try {
              await task;
            } catch (error) {
              (input.onError ?? logScheduleError)(error, cron);
            }
          }),
        );
      }
    } catch (error) {
      for (const job of jobs) {
        job.stop();
      }
      throw error;
    }
  }

  return {
    ...runtime,
    async close() {
      if (closed) {
        return;
      }
      closed = true;
      for (const job of jobs.splice(0)) {
        job.stop();
      }
    },
  };
}

function indexTaskNamesByCron(
  registrations: readonly ScheduleRegistration[],
): ReadonlyMap<string, readonly string[]> {
  const taskNamesByCron = new Map<string, string[]>();

  for (const registration of registrations) {
    const taskNames = taskNamesByCron.get(registration.cron) ?? [];
    if (!taskNames.includes(registration.taskName)) {
      taskNames.push(registration.taskName);
    }
    taskNamesByCron.set(registration.cron, taskNames);
  }

  return taskNamesByCron;
}

function logScheduleError(error: unknown, cron: string): void {
  console.error(`Error while running scheduled tasks for "${cron}"`, error);
}
