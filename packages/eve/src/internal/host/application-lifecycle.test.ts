import { describe, expect, it, vi } from "vitest";

import { ApplicationLifecycle } from "./application-lifecycle.js";

describe("ApplicationLifecycle", () => {
  it("runs close hooks once in registration order", async () => {
    const calls: string[] = [];
    const lifecycle = new ApplicationLifecycle();
    lifecycle.hooks.hook("close", () => calls.push("first"));
    lifecycle.onClose(async () => {
      await Promise.resolve();
      calls.push("second");
    });

    await Promise.all([lifecycle.close(), lifecycle.close()]);

    expect(calls).toEqual(["first", "second"]);
  });

  it("settles every close hook and reports all failures", async () => {
    const afterFailure = vi.fn();
    const lifecycle = new ApplicationLifecycle();
    lifecycle.onClose(() => {
      throw new Error("first failure");
    });
    lifecycle.onClose(afterFailure);
    lifecycle.onClose(() => Promise.reject(new Error("second failure")));

    await expect(lifecycle.close()).rejects.toMatchObject({
      errors: [expect.objectContaining({ message: "first failure" }), expect.any(Error)],
    });
    expect(afterFailure).toHaveBeenCalledOnce();
  });

  it("rejects hooks other than close", () => {
    const lifecycle = new ApplicationLifecycle();

    expect(() => lifecycle.hooks.hook("request", () => {})).toThrow(
      "Unsupported eve application lifecycle hook: request",
    );
  });
});
