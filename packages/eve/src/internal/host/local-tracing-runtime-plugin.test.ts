import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEVELOPMENT_WORKER_APP_ROOT_ENV } from "#internal/workflow/development-world-protocol.js";

const tracingMocks = vi.hoisted(() => ({
  installLocalInstrumentationRuntime: vi.fn(),
  shutdown: vi.fn<() => Promise<void>>(),
}));

const packageMocks = vi.hoisted(() => ({
  resolveInstalledPackageInfo: vi.fn(() => ({ version: "1.2.3" })),
}));

vi.mock("#tracing/local-instrumentation-runtime.js", () => ({
  installLocalInstrumentationRuntime: tracingMocks.installLocalInstrumentationRuntime,
}));
vi.mock("#internal/application/package.js", () => packageMocks);

describe("installLocalTracingRuntimePlugin", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv(DEVELOPMENT_WORKER_APP_ROOT_ENV, "/workspace/weather-agent");
    tracingMocks.shutdown.mockReset().mockResolvedValue(undefined);
    tracingMocks.installLocalInstrumentationRuntime.mockReset().mockReturnValue({
      shutdown: tracingMocks.shutdown,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers tracing shutdown with the eve application lifecycle", async () => {
    const plugin = (await import("#internal/host/local-tracing-runtime-plugin.js")) as {
      default: (lifecycle: { onClose(handler: () => Promise<void>): void }) => void;
    };
    let closeHandler: (() => Promise<void>) | undefined;

    plugin.default({
      onClose(handler) {
        closeHandler = handler;
      },
    });

    expect(tracingMocks.installLocalInstrumentationRuntime).toHaveBeenCalledWith({
      appRoot: "/workspace/weather-agent",
      frameworkVersion: "1.2.3",
      serviceName: "weather-agent",
    });
    await closeHandler?.();
    expect(tracingMocks.shutdown).toHaveBeenCalledOnce();
  });
});
