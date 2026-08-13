import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearActiveSandboxHandlesForTest,
  trackActiveSandboxHandle,
} from "#execution/sandbox/active-handles.js";
import {
  installSandboxShutdownLifecycle,
  runSandboxShutdown,
  shouldInstallSandboxShutdown,
} from "#internal/host/sandbox-shutdown-plugin.js";

afterEach(() => {
  clearActiveSandboxHandlesForTest();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("shouldInstallSandboxShutdown", () => {
  it("installs on a plain production server", () => {
    expect(shouldInstallSandboxShutdown({})).toBe(true);
  });

  it("skips eve dev processes", () => {
    vi.stubEnv("EVE_DEV", "1");
    expect(shouldInstallSandboxShutdown({})).toBe(false);
  });

  it("skips dev sandbox run workers", () => {
    expect(shouldInstallSandboxShutdown({ EVE_DEVELOPMENT_SANDBOX_RUN_ID: "dev-run" })).toBe(false);
  });

  it("skips Vercel serverless instances", () => {
    expect(shouldInstallSandboxShutdown({ VERCEL: "1" })).toBe(false);
  });
});

describe("installSandboxShutdownLifecycle", () => {
  it("registers no close handler when shutdown ownership is elsewhere", () => {
    const onClose = vi.fn();

    installSandboxShutdownLifecycle({
      environment: { VERCEL: "1" },
      lifecycle: { onClose },
      log: () => {},
    });

    expect(onClose).not.toHaveBeenCalled();
  });

  it("stops tracked sandboxes through the application lifecycle", async () => {
    const handle = { shutdown: vi.fn(async () => {}) };
    trackActiveSandboxHandle({ backendName: "docker", handle, sessionKey: "session-1" });
    let closeHandler: (() => Promise<void>) | undefined;
    const lifecycle = {
      onClose(handler: () => Promise<void>) {
        closeHandler = handler;
      },
    };

    installSandboxShutdownLifecycle({
      environment: {},
      lifecycle,
      log: () => {},
    });
    await closeHandler?.();

    expect(handle.shutdown).toHaveBeenCalledTimes(1);
  });

  it("does not register process signal listeners", () => {
    const once = vi.spyOn(process, "once");

    installSandboxShutdownLifecycle({
      environment: {},
      lifecycle: { onClose() {} },
      log: () => {},
    });

    expect(once).not.toHaveBeenCalled();
    once.mockRestore();
  });
});

describe("runSandboxShutdown", () => {
  it("exits even when a handle shutdown never settles", async () => {
    vi.useFakeTimers();
    try {
      const handle = { shutdown: vi.fn(() => new Promise<void>(() => {})) };
      trackActiveSandboxHandle({ backendName: "docker", handle, sessionKey: "session-1" });
      const log = vi.fn();

      const shutdown = runSandboxShutdown(log);
      await vi.advanceTimersByTimeAsync(15_000);
      await shutdown;

      expect(log).toHaveBeenCalledWith(expect.stringContaining("timed out"));
    } finally {
      vi.useRealTimers();
    }
  });
});
