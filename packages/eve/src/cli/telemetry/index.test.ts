import { spawn } from "node:child_process";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));

import { canonicalCommand, createEveCliTelemetry } from "#cli/telemetry/index.js";
import { isVercelTelemetryDisabled } from "#cli/telemetry/vercel-preference.js";

vi.mock("#cli/telemetry/vercel-preference.js", () => ({
  isVercelTelemetryDisabled: vi.fn(async () => false),
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  vi.mocked(isVercelTelemetryDisabled).mockReset().mockResolvedValue(false);
});

describe("canonicalCommand", () => {
  it("records default and nested command paths without user-supplied values", () => {
    expect(canonicalCommand([])).toBe("dev");
    expect(canonicalCommand(["dev", "https://agent.example"])).toBe("dev");
    expect(canonicalCommand(["registry", "search", "private-query"])).toBe("registry:search");
    expect(canonicalCommand(["logs"])).toBe("logs:show");
  });

  it("records supported top-level commands and buckets unknown commands", () => {
    expect(canonicalCommand(["set", "--model", "private/model"])).toBe("set");
    expect(canonicalCommand(["not-a-command", "private-argument"])).toBe("unknown");
  });
});

describe("createEveCliTelemetry", () => {
  it("does not spawn a flush process when the environment override disables telemetry", async () => {
    vi.stubEnv("EVE_TELEMETRY_DISABLED", "1");
    const telemetry = createEveCliTelemetry("1.0.0");
    telemetry.trackCommand("info");

    await telemetry.flush();

    expect(spawn).not.toHaveBeenCalled();
    expect(isVercelTelemetryDisabled).not.toHaveBeenCalled();
  });

  it("does not spawn a flush process when Vercel CLI telemetry is disabled", async () => {
    vi.mocked(isVercelTelemetryDisabled).mockResolvedValue(true);
    const telemetry = createEveCliTelemetry("1.0.0");
    telemetry.trackCommand("info");

    await telemetry.flush();

    expect(spawn).not.toHaveBeenCalled();
  });

  it("flushes an allowlisted outcome through a telemetry-disabled child process", async () => {
    const child = { unref: vi.fn() };
    vi.mocked(spawn).mockReturnValue(child as never);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("EVE_TELEMETRY_DISABLED", "");
    const telemetry = createEveCliTelemetry("1.0.0");
    telemetry.trackCommand("info");
    telemetry.trackOutcome("usage_error");

    await telemetry.flush();

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([process.argv[1], "telemetry", "flush"]),
      expect.objectContaining({
        detached: true,
        env: expect.objectContaining({ EVE_TELEMETRY_DISABLED: "1" }),
      }),
    );
    expect(child.unref).toHaveBeenCalled();
    const payload = JSON.parse(vi.mocked(spawn).mock.calls[0]![1][3]!) as {
      events: Array<{ key: string; value: string }>;
    };
    expect(payload.events).toContainEqual(
      expect.objectContaining({ key: "outcome", value: "usage_error" }),
    );
    expect(payload.events).not.toContainEqual(expect.objectContaining({ key: "error_code" }));
    expect(payload.events).not.toContainEqual(expect.objectContaining({ key: "error_status" }));
  });
});
