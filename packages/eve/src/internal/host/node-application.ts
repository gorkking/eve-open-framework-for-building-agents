import { serve } from "#compiled/crossws/node.js";

import type { ApplicationLifecycle } from "#internal/host/application-lifecycle.js";
import {
  type ApplicationFetch,
  ApplicationTaskTracker,
  createTrackedApplicationFetch,
} from "#internal/host/application-task-tracker.js";
import { createApplicationWebSocketResolver } from "#internal/host/application-websocket.js";
import {
  startLocalScheduleRunner,
  type LocalScheduleRunner,
  type LocalScheduleRunnerOptions,
} from "#internal/host/schedule-runtime.js";

export interface StartNodeApplicationOptions {
  readonly fetch: ApplicationFetch;
  readonly gracefulShutdown?: boolean;
  readonly hostname?: string;
  readonly lifecycle: ApplicationLifecycle;
  readonly port?: number | string;
  readonly scheduleRuntimeOptions?: Omit<LocalScheduleRunnerOptions, "waitUntil">;
  readonly silent?: boolean;
  readonly websocket?: boolean;
}

export interface NodeApplication {
  readonly url: string | undefined;
  readonly waitUntil: ((task: Promise<unknown>) => void) | undefined;
  close(): Promise<void>;
}

/** Starts the self-hosted Node transport and its process-local schedule timers. */
export async function startNodeApplication(
  options: StartNodeApplicationOptions,
): Promise<NodeApplication> {
  const taskTracker = new ApplicationTaskTracker();
  const fetch = createTrackedApplicationFetch(options.fetch, taskTracker);
  const server = serve({
    fetch,
    gracefulShutdown: false,
    hostname: options.hostname,
    manual: true,
    port: options.port,
    silent: options.silent,
    websocket: options.websocket
      ? { resolve: createApplicationWebSocketResolver(fetch) }
      : undefined,
  });

  let scheduleRunner: LocalScheduleRunner | undefined;

  try {
    server.serve();
    await server.ready();

    if (options.scheduleRuntimeOptions !== undefined) {
      scheduleRunner = startLocalScheduleRunner({
        ...options.scheduleRuntimeOptions,
        waitUntil: taskTracker.waitUntil,
      });
    }
  } catch (error) {
    const cleanupErrors = await closeApplicationParts([
      () => server.close(true),
      () => taskTracker.close(),
      () => options.lifecycle.close(),
    ]);
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        "Failed to start and clean up the eve Node application.",
      );
    }
    throw error;
  }

  let closePromise: Promise<void> | undefined;
  let removeSignalHandlers = () => {};
  const application: NodeApplication = {
    get url() {
      return server.url;
    },
    waitUntil: taskTracker.waitUntil,
    close() {
      removeSignalHandlers();
      closePromise ??= closeNodeApplication(scheduleRunner, server, taskTracker, options.lifecycle);
      return closePromise;
    },
  };

  if (shouldHandleShutdownSignals(options.gracefulShutdown)) {
    const shutdown = () => {
      void application.close().catch((error: unknown) => {
        process.exitCode = 1;
        console.error("Failed to close the eve Node application.", error);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
    removeSignalHandlers = () => {
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
    };
  }

  return application;
}

function shouldHandleShutdownSignals(configured: boolean | undefined): boolean {
  return configured ?? !(process.env.CI || process.env.TEST);
}

async function closeNodeApplication(
  scheduleRunner: LocalScheduleRunner | undefined,
  server: { close(closeActiveConnections?: boolean): Promise<void> },
  taskTracker: ApplicationTaskTracker,
  lifecycle: ApplicationLifecycle,
): Promise<void> {
  const errors = await closeApplicationParts([
    ...(scheduleRunner === undefined ? [] : [() => scheduleRunner.close()]),
    () => server.close(true),
    () => taskTracker.close(),
    () => lifecycle.close(),
  ]);

  if (errors.length > 0) {
    throw new AggregateError(errors, "Failed to close the eve Node application.");
  }
}

async function closeApplicationParts(
  closeHandlers: readonly (() => unknown | Promise<unknown>)[],
): Promise<unknown[]> {
  const errors: unknown[] = [];

  for (const close of closeHandlers) {
    try {
      await close();
    } catch (error) {
      errors.push(error);
    }
  }

  return errors;
}
