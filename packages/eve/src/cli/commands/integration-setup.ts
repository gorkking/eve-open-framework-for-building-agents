import { headlessAsker, InteractionRequired, withAnswers, withPolicy } from "#setup/ask.js";
import { createHeadlessPrompter } from "#setup/headless.js";
import { SetupPrerequisiteRequired } from "#setup/integrations/shared/prerequisite.js";
import { createPrompter, type Prompter } from "#setup/prompter.js";
import { createRegistrySetupClient } from "#setup/registry-setup-client.js";
import {
  runIntegrationSetup,
  type IntegrationSetupRunnerDeps,
} from "#setup/integrations/runner.js";
import { isEveProject } from "#setup/scaffold/index.js";

import { NOT_AN_AGENT_MESSAGE } from "./preconditions.js";
import type { RegistryCommandLogger } from "./registry.js";

export interface IntegrationSetupOptions {
  yes?: boolean;
  headless?: boolean;
  json?: boolean;
  answers?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface IntegrationSetupDependencies {
  createPrompter?: () => Prompter;
  runnerDeps?: IntegrationSetupRunnerDeps;
}

const defaultIntegrationSetupDependencies: IntegrationSetupDependencies = {};

/** Runs built-in integration setup after its registry payload is installed. */
export async function runIntegrationSetupCommand(
  logger: RegistryCommandLogger,
  appRoot: string,
  kind: string,
  options: IntegrationSetupOptions = {},
  dependencies: IntegrationSetupDependencies = defaultIntegrationSetupDependencies,
): Promise<void> {
  if (!(await isEveProject(appRoot))) {
    logger.error(NOT_AN_AGENT_MESSAGE);
    process.exitCode = 1;
    return;
  }

  const client = createRegistrySetupClient({ signal: options.signal });
  try {
    const headless = options.headless === true;
    const prompter =
      client?.prompter ??
      dependencies.createPrompter?.() ??
      (headless ? createHeadlessPrompter(() => {}) : createPrompter());
    const base = headlessAsker();
    const asker = headless
      ? withAnswers(options.answers ?? {})(options.yes ? withPolicy("assume")(base) : base)
      : undefined;
    const result = await runIntegrationSetup(
      kind,
      {
        appRoot,
        prompter,
        asker,
        interaction: headless ? "headless" : "interactive",
        signal: client?.signal ?? options.signal,
        yes: options.yes,
      },
      dependencies.runnerDeps,
    );
    if (result.kind === "cancelled") {
      client?.cancel();
      if (process.env.EVE_SETUP === "1") process.exitCode = 130;
      return;
    }
    prompter.outro("Integration set up.");
    client?.complete(result.completion);
  } catch (error) {
    client?.fail(error);
    if (options.headless && options.json && error instanceof InteractionRequired) {
      logger.error(
        JSON.stringify({
          status: "input_required",
          setup_mutated: false,
          question: error.question,
        }),
      );
    } else if (options.headless && options.json && error instanceof SetupPrerequisiteRequired) {
      logger.error(
        JSON.stringify({
          status: "prerequisite_required",
          setup_mutated: false,
          prerequisite: { code: error.code, message: error.message, command: error.command },
        }),
      );
    } else {
      logger.error(error instanceof Error ? error.message : String(error));
    }
    process.exitCode = 1;
  }
}
