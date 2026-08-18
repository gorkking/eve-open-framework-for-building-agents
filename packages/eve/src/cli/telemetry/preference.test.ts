import { mkdir, readFile, rename, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs/promises", () => ({
  mkdir: vi.fn(),
  readFile: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  writeFile: vi.fn(),
}));

import {
  markEveTelemetryNotified,
  readEveTelemetryPreference,
  setEveTelemetryEnabled,
} from "#cli/telemetry/preference.js";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("eve telemetry preference", () => {
  it("defaults to enabled before a preference exists", async () => {
    vi.mocked(readFile).mockRejectedValue(new Error("missing"));

    await expect(readEveTelemetryPreference()).resolves.toEqual({ enabled: true, notified: false });
  });

  it("reads a persisted opt-out", async () => {
    vi.mocked(readFile).mockResolvedValue('{"telemetry":{"enabled":false,"notifiedAt":"now"}}');

    await expect(readEveTelemetryPreference()).resolves.toEqual({ enabled: false, notified: true });
  });

  it("merges telemetry changes into the eve config atomically", async () => {
    vi.stubEnv("XDG_CONFIG_HOME", "/eve-config");
    vi.mocked(readFile)
      .mockResolvedValueOnce('{"other":"preserved","telemetry":{"future":"preserved"}}')
      .mockResolvedValueOnce(
        '{"other":"preserved","telemetry":{"future":"preserved","enabled":false}}',
      );

    await setEveTelemetryEnabled(false);
    await markEveTelemetryNotified();

    expect(mkdir).toHaveBeenCalledWith("/eve-config/eve", { recursive: true });
    expect(writeFile).toHaveBeenNthCalledWith(
      1,
      expect.stringMatching(/^\/eve-config\/eve\/config\.json\./),
      expect.stringContaining('"other": "preserved"'),
      { mode: 0o600 },
    );
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^\/eve-config\/eve\/config\.json\./),
      expect.stringContaining('"future": "preserved"'),
      { mode: 0o600 },
    );
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^\/eve-config\/eve\/config\.json\./),
      expect.stringContaining('"enabled": false'),
      { mode: 0o600 },
    );
    expect(writeFile).toHaveBeenNthCalledWith(
      2,
      expect.stringMatching(/^\/eve-config\/eve\/config\.json\./),
      expect.stringContaining('"notifiedAt"'),
      { mode: 0o600 },
    );
    expect(rename).toHaveBeenCalledTimes(2);
  });
});
