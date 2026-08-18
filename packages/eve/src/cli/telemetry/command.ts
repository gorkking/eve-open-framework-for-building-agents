import { readEveTelemetryPreference, setEveTelemetryEnabled } from "#cli/telemetry/preference.js";

type TelemetryLogger = {
  log(message: string): void;
};

export async function showEveTelemetryStatus(logger: TelemetryLogger): Promise<void> {
  const { enabled } = await readEveTelemetryPreference();
  logger.log(`Telemetry status: ${enabled ? "Enabled" : "Disabled"}`);
}

export async function enableEveTelemetry(logger: TelemetryLogger): Promise<void> {
  await setEveTelemetryEnabled(true);
  logger.log("Telemetry collection enabled.");
}

export async function disableEveTelemetry(logger: TelemetryLogger): Promise<void> {
  await setEveTelemetryEnabled(false);
  logger.log("Telemetry collection disabled. No data will be collected from this machine.");
}
