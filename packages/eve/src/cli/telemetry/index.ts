import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";

type ErrorWithProperties = Error & {
  readonly code?: unknown;
  readonly status?: unknown;
};

export type EveCliTelemetryEvent = {
  readonly id: string;
  readonly event_time: number;
  readonly key: string;
  readonly value: string;
};

export type EveCliTelemetry = {
  trackCommand(command: string): void;
  trackDevContext(argv: readonly string[]): void;
  trackOutcome(outcome: "success" | "error"): void;
  trackError(error: unknown): void;
  flush(): Promise<void>;
};

function isEnabled(): boolean {
  return process.env.NODE_ENV !== "test" && !process.env.EVE_TELEMETRY_DISABLED;
}

function event(key: string, value: string): EveCliTelemetryEvent {
  return { id: randomUUID(), event_time: Date.now(), key, value };
}

function stringProperty(error: unknown, property: "code" | "status"): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const value = (error as ErrorWithProperties)[property];
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
}

function devContext(argv: readonly string[]): Array<[string, string]> {
  if (canonicalCommand(argv) !== "dev") return [];
  const remote = argv.some(
    (argument, index) =>
      argument === "--url" || argument === "-u" || (index === 1 && /^https?:\/\//.test(argument)),
  );
  const headless = argv.includes("--no-ui") || !process.stdin.isTTY || !process.stdout.isTTY;
  return [
    ["target", remote ? "remote" : "local"],
    ["ui", headless ? "headless" : "tui"],
  ];
}

/** Returns only an allowlisted command path; it never includes user input. */
export function canonicalCommand(argv: readonly string[]): string {
  const command = argv.find((argument) => !argument.startsWith("-"));
  if (command === undefined || /^https?:\/\//.test(command)) return "dev";

  const topLevel = new Set([
    "acp",
    "add",
    "build",
    "channels",
    "deploy",
    "dev",
    "eval",
    "extension",
    "info",
    "init",
    "integration",
    "invoke",
    "link",
    "logs",
    "registry",
    "start",
    "traces",
  ]);
  if (!topLevel.has(command)) return "unknown";

  const nested = argv
    .slice(argv.indexOf(command) + 1)
    .find((argument) => !argument.startsWith("-"));
  const subcommands: Record<string, ReadonlySet<string>> = {
    channels: new Set(["list"]),
    extension: new Set(["build", "init"]),
    integration: new Set(["connect", "setup"]),
    logs: new Set(["ls", "show"]),
    registry: new Set(["add", "list", "search", "view"]),
    traces: new Set(["ls"]),
  };
  const defaults: Record<string, string> = { logs: "show", traces: "show" };
  if (nested && subcommands[command]?.has(nested)) return `${command}:${nested}`;
  return defaults[command] ? `${command}:${defaults[command]}` : command;
}

export function createEveCliTelemetry(version: string): EveCliTelemetry {
  const events: EveCliTelemetryEvent[] = [
    event("version", version),
    event("platform", os.platform()),
    event("arch", os.arch()),
    event("stdin_is_tty", process.stdin.isTTY ? "true" : "false"),
  ];
  const sessionId = randomUUID();

  return {
    trackCommand(command) {
      events.push(event("command", command));
    },
    trackDevContext(argv) {
      for (const [key, value] of devContext(argv)) events.push(event(key, value));
    },
    trackOutcome(outcome) {
      events.push(event("outcome", outcome));
    },
    trackError(error) {
      const code = stringProperty(error, "code");
      if (code?.startsWith("commander.")) {
        events.push(event("error_kind", "usage"));
      } else if (code) {
        events.push(event("error_code", code));
      }
      const status = stringProperty(error, "status");
      if (status) events.push(event("error_status", status));
    },
    async flush() {
      if (!isEnabled() || events.length === 0) return;
      if (process.env.EVE_TELEMETRY_DEBUG) {
        process.stderr.write(`[eve telemetry] ${JSON.stringify(events)}\n`);
        return;
      }
      try {
        const child = spawn(
          process.execPath,
          [process.argv[1] ?? "", "telemetry", "flush", JSON.stringify({ events, sessionId })],
          {
            detached: true,
            env: { ...process.env, EVE_TELEMETRY_DISABLED: "1" },
            stdio: "ignore",
            windowsHide: true,
          },
        ) as ReturnType<typeof spawn>;
        child.unref();
      } catch {
        // Telemetry must never affect command output or exit status.
      }
    },
  };
}
