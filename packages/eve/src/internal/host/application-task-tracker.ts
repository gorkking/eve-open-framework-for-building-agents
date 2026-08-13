export type ApplicationFetch = (request: Request) => Response | Promise<Response>;

interface ApplicationServerRequest extends Request {
  waitUntil?: (task: Promise<unknown>) => void;
}

export interface ApplicationTaskTrackerOptions {
  readonly onError?: (error: unknown) => void;
}

/** Owns background work instead of delegating lifecycle state to a host adapter. */
export class ApplicationTaskTracker {
  readonly #onError: (error: unknown) => void;
  readonly #tasks = new Set<Promise<void>>();
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: ApplicationTaskTrackerOptions = {}) {
    this.#onError = options.onError ?? ((error) => console.error(error));
  }

  readonly waitUntil = (task: Promise<unknown>): void => {
    if (this.#closed) {
      void Promise.resolve(task).catch((error: unknown) => this.#reportError(error));
      throw new Error("Cannot register eve application work after shutdown completed.");
    }

    let tracked!: Promise<void>;
    tracked = Promise.resolve(task)
      .then(
        () => undefined,
        (error: unknown) => this.#reportError(error),
      )
      .finally(() => {
        this.#tasks.delete(tracked);
      });
    this.#tasks.add(tracked);
  };

  get pendingTaskCount(): number {
    return this.#tasks.size;
  }

  track<T>(operation: Promise<T>): Promise<T> {
    if (this.#closed) {
      throw new Error("Cannot start eve application work after shutdown completed.");
    }

    let tracked!: Promise<void>;
    tracked = operation
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        this.#tasks.delete(tracked);
      });
    this.#tasks.add(tracked);
    return operation;
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#drain();
    return this.#closePromise;
  }

  async #drain(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.all(this.#tasks);
    }
    this.#closed = true;
  }

  #reportError(error: unknown): void {
    try {
      this.#onError(error);
    } catch {
      // A diagnostic callback must not create an unhandled background rejection.
    }
  }
}

/** Replaces a platform request's waitUntil with the eve-owned task tracker. */
export function createTrackedApplicationFetch(
  fetch: ApplicationFetch,
  tracker: ApplicationTaskTracker,
): ApplicationFetch {
  return (request) => {
    (request as ApplicationServerRequest).waitUntil = tracker.waitUntil;
    return tracker.track(Promise.resolve().then(() => fetch(request)));
  };
}
