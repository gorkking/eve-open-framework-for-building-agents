export type ApplicationCloseHandler = () => unknown | Promise<unknown>;

/**
 * Minimal lifecycle surface passed to eve's generated runtime plugins.
 *
 * The existing generated plugins only register `close` hooks. Keeping that
 * contract here lets the host own shutdown without pulling in a framework hook
 * system or exposing a third-party lifecycle API.
 */
export class ApplicationLifecycle {
  readonly hooks = {
    hook: (name: string, handler: ApplicationCloseHandler): void => {
      if (name !== "close") {
        throw new Error(`Unsupported eve application lifecycle hook: ${name}`);
      }
      this.onClose(handler);
    },
  };

  readonly #closeHandlers: ApplicationCloseHandler[] = [];
  #closePromise: Promise<void> | undefined;

  onClose(handler: ApplicationCloseHandler): void {
    if (this.#closePromise !== undefined) {
      throw new Error("Cannot register an eve application close handler after shutdown started.");
    }
    this.#closeHandlers.push(handler);
  }

  close(): Promise<void> {
    this.#closePromise ??= this.#runCloseHandlers();
    return this.#closePromise;
  }

  async #runCloseHandlers(): Promise<void> {
    const results = await Promise.allSettled(
      this.#closeHandlers.map((handler) => Promise.resolve().then(handler)),
    );
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );

    if (errors.length > 0) {
      throw new AggregateError(errors, "Failed to close the eve application runtime.");
    }
  }
}
