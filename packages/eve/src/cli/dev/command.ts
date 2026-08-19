import { Command, InvalidArgumentError } from "#compiled/commander/index.js";
import { applicationCommand, type CliApplicationContext } from "#cli/application-command.js";
import type { DevelopmentCliOptions } from "#cli/dev/command-options.js";
import { resolveDevUiMode, resolveTuiDisplayOptions } from "#cli/dev/ui-options.js";
import type { RunDevelopmentTuiInput } from "#cli/dev/tui/tui.js";
import { resolveTuiTitle, type DevelopmentTuiTarget } from "#cli/dev/tui/target.js";
import { parseDevelopmentServerUrl } from "#cli/dev/url.js";
import { parseDevelopmentHeaderOption, resolveDevelopmentUrlTarget } from "#cli/dev/url-target.js";
import {
  parseContextSizeOption,
  parseDisplayMode,
  parseLogsMode,
  parsePortOption,
  parseStatsMode,
} from "#cli/option-parsers.js";
import { waitForServerOrStop, waitForUiOrServer } from "#cli/dev/wait-for-ui.js";
import {
  FORCED_EXIT_BACKSTOP_MS,
  installShutdownSignal,
  type CommandLifecycle,
} from "#cli/shutdown.js";
import { startCliLiveRow } from "#cli/ui/live-row.js";
import { createCliTheme, renderCliTaggedLine } from "#cli/ui/output.js";
import { type DevBootProgressReporter, devBootPhase } from "#internal/dev-boot-progress.js";
import { createLogger } from "#internal/logging.js";
import type { DevelopmentServer, DevelopmentServerOptions } from "#internal/nitro/host/types.js";
import {
  resumeDevelopmentRuntimeArtifacts,
  suspendDevelopmentRuntimeArtifacts,
} from "#services/dev-client/runtime-artifacts.js";

export interface DevCommandLogger {
  log(message: string): void;
}

export interface DevCommandRuntime {
  isActiveDevelopmentServerForApp?(input: {
    readonly appRoot: string;
    readonly serverUrl: string;
  }): Promise<boolean>;
  runDevelopmentTui?(input: RunDevelopmentTuiInput): Promise<void>;
  startHost?(appRoot: string, options?: DevelopmentServerOptions): DevelopmentServer;
}

export interface DevCommandTelemetry {
  trackDevContext(context: { target: "local" | "remote"; ui: "tui" | "headless" }): void;
}

function hasInteractiveTerminal(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

async function loadIsActiveDevelopmentServerForApp(): Promise<
  NonNullable<DevCommandRuntime["isActiveDevelopmentServerForApp"]>
> {
  return (await import("#internal/nitro/host.js")).isActiveDevelopmentServerForApp;
}

async function loadRunDevelopmentTui(): Promise<
  NonNullable<DevCommandRuntime["runDevelopmentTui"]>
> {
  return (await import("#cli/dev/tui/tui.js")).runDevelopmentTui;
}

async function loadStartHost(): Promise<NonNullable<DevCommandRuntime["startHost"]>> {
  return (await import("#cli/dev/local-server-process.js")).createDevelopmentServer;
}

const devBootLog = createLogger("dev.boot");

function createDevBootProgressReporter(
  row: ReturnType<typeof startCliLiveRow> | undefined,
): DevBootProgressReporter {
  return (event) => {
    switch (event.type) {
      case "phase-started":
        row?.update("Building your agent", event.phase);
        devBootLog.debug(event.phase);
        return;
      case "phase-finished":
        devBootLog.debug(`${event.phase} finished`, { ms: event.elapsedMs });
        return;
      case "before-first-paint":
        row?.stop();
        return;
      default: {
        const exhaustive: never = event;
        return exhaustive;
      }
    }
  };
}

export function registerDevCommand(input: {
  readonly applicationContext: CliApplicationContext;
  readonly logger: DevCommandLogger;
  readonly program: Command;
  readonly runtime: DevCommandRuntime;
  readonly telemetry: DevCommandTelemetry;
}): void {
  const { applicationContext, logger, program, runtime, telemetry } = input;
  const theme = createCliTheme();
  applicationCommand(program.command("dev"), applicationContext, (command) => {
    const options = command.opts<DevelopmentCliOptions>();
    return (
      resolveDevelopmentUrlTarget(options, command.processedArgs[0] as string | undefined) ===
      undefined
    );
  })
    .description("Start the eve development server or connect to an existing URL.")
    .argument("[url]", "Connect to an existing server URL", parseDevelopmentServerUrl)
    .option("--host <host>", "Host interface to bind")
    .option("--port <port>", "Port to listen on (defaults to $PORT, then 2000)", parsePortOption)
    .option("-u, --url <url>", "Connect to an existing server URL", parseDevelopmentServerUrl)
    .option(
      "-H, --header <header>",
      'Request header for a URL target, in "Name: value" form (repeatable)',
      parseDevelopmentHeaderOption,
    )
    .option("--no-ui", "Start the server without an interactive UI")
    .option("--name <name>", "Title shown in the terminal UI (defaults to the app folder name)")
    .option("--input <text>", "Pre-fill the prompt input, or start onboarding with /model")
    .option(
      "--tools <mode>",
      "How tool calls render: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--reasoning <mode>",
      "How reasoning renders: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--subagents <mode>",
      "How subagent sections render: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--connection-auth <mode>",
      "How connection authorization renders: full | collapsed | auto-collapsed | hidden",
      parseDisplayMode,
    )
    .option(
      "--assistant-response-stats <mode>",
      "Assistant header statistic: tokens | tokensPerSecond",
      parseStatsMode,
    )
    .option(
      "--context-size <tokens>",
      "Model context window size, shown as a usage percentage",
      parseContextSizeOption,
    )
    .option(
      "--logs <mode>",
      "Which server/agent logs to show: all | stderr | sandbox | none",
      parseLogsMode,
    )
    .addHelpText(
      "after",
      "\nYou can also pass a bare URL, for example: eve dev https://example.com\n",
    )
    .action(async (positionalUrl: string | undefined, options: DevelopmentCliOptions) => {
      const remoteTarget = resolveDevelopmentUrlTarget(options, positionalUrl);
      const remoteServerUrl = remoteTarget?.serverUrl;
      const interactive = hasInteractiveTerminal();
      const mode = resolveDevUiMode({ options, interactive });
      telemetry.trackDevContext({ target: remoteTarget ? "remote" : "local", ui: mode });
      if (options.input !== undefined && mode === "headless") {
        throw new InvalidArgumentError("--input requires the interactive UI.");
      }
      let existingLocalDevelopmentServer = false;
      if (remoteServerUrl !== undefined) {
        const isActive =
          runtime.isActiveDevelopmentServerForApp ?? (await loadIsActiveDevelopmentServerForApp());
        existingLocalDevelopmentServer = await isActive({
          appRoot: applicationContext.root,
          serverUrl: remoteServerUrl,
        });
      }
      const runInteractiveUi = async (
        input: {
          readonly appRoot?: string;
          readonly serverUrl: string;
        },
        report?: DevBootProgressReporter,
        lifecycle?: CommandLifecycle,
      ): Promise<void> => {
        const runDevelopmentTui = await devBootPhase(
          "loading interactive UI",
          async () => runtime.runDevelopmentTui ?? (await loadRunDevelopmentTui()),
          report,
        );
        const display = resolveTuiDisplayOptions(options);
        const target: DevelopmentTuiTarget =
          remoteServerUrl === undefined || existingLocalDevelopmentServer
            ? {
                kind: "local",
                serverUrl: input.serverUrl,
                workspaceRoot: input.appRoot ?? applicationContext.root,
              }
            : {
                kind: "remote",
                serverUrl: input.serverUrl,
                workspaceRoot: applicationContext.root,
              };
        const title = resolveTuiTitle({ name: options.name, target });
        if (title !== undefined) display.name = title;
        const tuiInput: RunDevelopmentTuiInput = {
          target,
          initialInput: options.input,
          onBootProgress: report,
          lifecycle,
          ...display,
        };
        if (target.kind === "local") {
          tuiInput.withExclusiveTerminal = async <T>(task: () => Promise<T>): Promise<T> => {
            const run = async (): Promise<T> => {
              if (!(await suspendDevelopmentRuntimeArtifacts({ serverUrl: input.serverUrl }))) {
                throw new Error("Could not pause the development server for integration setup.");
              }
              try {
                return await task();
              } finally {
                await resumeDevelopmentRuntimeArtifacts({
                  serverUrl: input.serverUrl,
                  silent: true,
                });
              }
            };
            return await run();
          };
        }
        if (remoteTarget?.headers !== undefined) {
          await runDevelopmentTui({ ...tuiInput, headers: remoteTarget.headers });
        } else {
          await runDevelopmentTui(tuiInput);
        }
      };

      if (remoteServerUrl) {
        const { loadDevelopmentEnvironmentFiles } = await import("#cli/dev/environment.js");
        loadDevelopmentEnvironmentFiles(applicationContext.root);
        logger.log(
          `↗ ${existingLocalDevelopmentServer ? "local" : "remote"} mode targeting ${theme.info(new URL(remoteServerUrl).host)}`,
        );

        if (mode === "headless") {
          logger.log(
            renderCliTaggedLine(theme, {
              message: "Interactive UI disabled because the current terminal is not a TTY.",
              tag: "dev",
              tone: "warning",
            }),
          );
          return;
        }

        logger.log("");
        const lifecycle = installShutdownSignal({ exitAfterMs: FORCED_EXIT_BACKSTOP_MS });
        try {
          await runInteractiveUi({ serverUrl: remoteServerUrl }, undefined, lifecycle);
        } finally {
          lifecycle.dispose();
        }
        return;
      }

      if (mode === "tui") logger.log("");
      const buildProgress = mode === "tui" ? startCliLiveRow(logger) : undefined;
      const onBootProgress = createDevBootProgressReporter(buildProgress);
      buildProgress?.update("Building your agent");

      let server: DevelopmentServer | undefined;
      let closePromise: Promise<void> | undefined;
      const closeServer = () => {
        if (server === undefined) return Promise.resolve();
        closePromise ??= server.close();
        void closePromise.catch(() => undefined);
        return closePromise;
      };
      const lifecycle = installShutdownSignal({
        exitAfterMs: FORCED_EXIT_BACKSTOP_MS,
        onStop: () => {
          void closeServer();
        },
      });

      try {
        const startHost = runtime.startHost ?? (await loadStartHost());
        server = startHost(applicationContext.root, {
          existing: mode === "tui" ? "attach-if-unconfigured" : "reject",
          host: options.host,
          onBootProgress,
          port: options.port,
        });
        const outcome = await Promise.race([
          server.start().then((handle) => ({ handle })),
          lifecycle.stopped.then(() => ({ handle: undefined })),
        ]);
        const handle = outcome.handle;
        if (handle === undefined) return;

        if (mode !== "tui") {
          logger.log(
            renderCliTaggedLine(theme, {
              message: `server listening at ${handle.url}`,
              tag: "dev",
              tone: "success",
            }),
          );
        }

        if (mode === "headless") {
          if (options.ui !== false && !interactive) {
            logger.log(
              renderCliTaggedLine(theme, {
                message: "Interactive UI disabled because the current terminal is not a TTY.",
                tag: "dev",
                tone: "warning",
              }),
            );
          }

          await waitForServerOrStop(server, lifecycle);
          return;
        }

        await waitForUiOrServer({
          handle,
          lifecycle,
          server,
          runUi: async () =>
            await runInteractiveUi(
              { appRoot: handle.appRoot, serverUrl: handle.url },
              onBootProgress,
              lifecycle,
            ),
        });
      } finally {
        buildProgress?.stop();
        await closeServer();
        lifecycle.dispose();
      }
    });
}
