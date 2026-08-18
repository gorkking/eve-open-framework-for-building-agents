import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { z } from "zod";

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

const EveConfigSchema = z.looseObject({
  telemetry: z
    .looseObject({
      enabled: z.boolean().optional(),
      notifiedAt: z.string().optional(),
    })
    .optional(),
});

function parsePreference(value: unknown): EveTelemetryPreference {
  const telemetry = EveConfigSchema.safeParse(value).data?.telemetry;
  return {
    enabled: telemetry?.enabled !== false,
    notified: typeof telemetry?.notifiedAt === "string",
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
