import { describe, expect, it, vi } from "vitest";

import {
  ApplicationTaskTracker,
  createTrackedApplicationFetch,
} from "./application-task-tracker.js";

describe("ApplicationTaskTracker", () => {
  it("removes the exact tracked promise after background work settles", async () => {
    const tracker = new ApplicationTaskTracker();

    for (let index = 0; index < 100; index += 1) {
      tracker.waitUntil(Promise.resolve(index));
    }
    expect(tracker.pendingTaskCount).toBe(100);

    await Promise.resolve();
    await Promise.resolve();

    expect(tracker.pendingTaskCount).toBe(0);
    await tracker.close();
  });

  it("waits for pending and transitively registered work during shutdown", async () => {
    const first = deferred<void>();
    const second = deferred<void>();
    const tracker = new ApplicationTaskTracker();
    tracker.waitUntil(
      first.promise.then(() => {
        tracker.waitUntil(second.promise);
      }),
    );

    let closed = false;
    const closing = tracker.close().then(() => {
      closed = true;
    });
    first.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(tracker.pendingTaskCount).toBeGreaterThan(0);

    second.resolve();
    await closing;
    expect(closed).toBe(true);
    expect(tracker.pendingTaskCount).toBe(0);
    expect(() => tracker.waitUntil(Promise.resolve())).toThrow(
      "Cannot register eve application work after shutdown completed.",
    );
  });

  it("reports rejected work without rejecting shutdown", async () => {
    const onError = vi.fn();
    const tracker = new ApplicationTaskTracker({ onError });
    const failure = new Error("background failed");
    tracker.waitUntil(Promise.reject(failure));

    await expect(tracker.close()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(failure);
  });

  it("installs its waitUntil function on every request", async () => {
    const tracker = new ApplicationTaskTracker();
    let observedWaitUntil: unknown;
    const fetch = createTrackedApplicationFetch(async (request) => {
      observedWaitUntil = (request as Request & { waitUntil?: unknown }).waitUntil;
      return new Response("ok");
    }, tracker);

    const response = await fetch(new Request("https://example.com/"));

    expect(await response.text()).toBe("ok");
    expect(observedWaitUntil).toBe(tracker.waitUntil);
    await tracker.close();
  });

  it("keeps shutdown open for an admitted request and its late background work", async () => {
    const requestGate = deferred<void>();
    const backgroundGate = deferred<void>();
    const tracker = new ApplicationTaskTracker();
    const fetch = createTrackedApplicationFetch(async (request) => {
      await requestGate.promise;
      (request as Request & { waitUntil: (task: Promise<unknown>) => void }).waitUntil(
        backgroundGate.promise,
      );
      return new Response("ok");
    }, tracker);
    const responsePromise = fetch(new Request("https://example.com/"));
    let closed = false;
    const closing = tracker.close().then(() => {
      closed = true;
    });

    await Promise.resolve();
    expect(closed).toBe(false);
    requestGate.resolve();
    await responsePromise;
    await Promise.resolve();
    expect(closed).toBe(false);

    backgroundGate.resolve();
    await closing;
    expect(closed).toBe(true);
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
