import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type EveTelemetryPreference = {
  readonly enabled: boolean;
  readonly notified: boolean;
};

function eveConfigPath(): string {
  const home = homedir();
  if (process.platform === "win32") {
    return join(process.env.APPDATA ?? join(home, "AppData", "Roaming"), "eve", "config.json");
  }
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "eve", "config.json");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, ".config"), "eve", "config.json");
}

function parsePreference(value: unknown): EveTelemetryPreference {
  if (typeof value !== "object" || value === null || !("telemetry" in value)) {
    return { enabled: true, notified: false };
  }
  const telemetry = value.telemetry;
  if (typeof telemetry !== "object" || telemetry === null) {
    return { enabled: true, notified: false };
  }
  return {
    enabled: !("enabled" in telemetry && telemetry.enabled === false),
    notified: "notifiedAt" in telemetry && typeof telemetry.notifiedAt === "string",
  };
}

export async function readEveTelemetryPreference(): Promise<EveTelemetryPreference> {
  try {
    return parsePreference(JSON.parse(await readFile(eveConfigPath(), "utf8")) as unknown);
  } catch {
    return { enabled: true, notified: false };
  }
}

async function updateEveTelemetryPreference(
  update: Record<string, boolean | string>,
): Promise<void> {
  const path = eveConfigPath();
  let existing: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (typeof parsed === "object" && parsed !== null) existing = parsed as Record<string, unknown>;
  } catch {
    // An absent or malformed config starts with the telemetry preference.
  }

  const telemetry =
    typeof existing.telemetry === "object" && existing.telemetry !== null ? existing.telemetry : {};
  const next = { ...existing, telemetry: { ...telemetry, ...update } };
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

export async function setEveTelemetryEnabled(enabled: boolean): Promise<void> {
  await updateEveTelemetryPreference({ enabled });
}

export async function markEveTelemetryNotified(): Promise<void> {
  await updateEveTelemetryPreference({ notifiedAt: new Date().toISOString() });
}
