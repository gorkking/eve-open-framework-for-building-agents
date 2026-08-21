import type { Prompter } from "#setup/prompter.js";
import { detectDeployment } from "#setup/project-resolution.js";
import { mergeRegistrySetupCompletions } from "#setup/registry-setup-completion.js";
import type { RegistrySetupCompletion, RegistrySetupFact } from "#setup/registry-setup-protocol.js";

import { runDeployFlow } from "./deploy.js";

export interface RegistrySessionDeps {
  detectDeployment: typeof detectDeployment;
  runDeployFlow: typeof runDeployFlow;
}

export interface RegistrySessionItemResult {
  address: string;
  title: string;
  facts: readonly RegistrySetupFact[];
  output: readonly string[];
}

/** An item the user chose to skip after its installation could not complete. */
export interface RegistrySessionItemFailure {
  address: string;
  title: string;
  /** Concise error shown while the setup panel asks whether to skip the item. */
  message: string;
  /** Full diagnostic preserved for the permanent setup report. */
  detail: string;
}

export interface RegistrySessionResult {
  kind: "done";
  addedItems: readonly string[];
  items: readonly RegistrySessionItemResult[];
  /** Installation failures retained when a user skips an item. */
  failures: readonly RegistrySessionItemFailure[];
  facts: readonly RegistrySetupFact[];
  output: readonly string[];
  deployed?: "production";
}

export interface RegistrySession {
  add(
    item: string,
    title: string,
    output: readonly string[],
    setup?: RegistrySetupCompletion,
  ): void;
  addFailure(item: string, title: string, message: string, detail: string): void;
  result(deployed?: "production"): RegistrySessionResult;
  continueAfterInstall(input: {
    appRoot: string;
    prompter: Prompter;
    signal?: AbortSignal;
    allowAddMore?: boolean;
  }): Promise<"add-more" | RegistrySessionResult>;
}

/** Owns the accumulated output and deployment decision for one `/add` session. */
export function createRegistrySession(deps: RegistrySessionDeps): RegistrySession {
  const addedItems: string[] = [];
  const items: RegistrySessionItemResult[] = [];
  const failures: RegistrySessionItemFailure[] = [];
  const output: string[] = [];
  let completion: RegistrySetupCompletion = { facts: [] };
  let currentItem = "";
  let currentFacts: readonly RegistrySetupFact[] = [];

  function result(deployed?: "production"): RegistrySessionResult {
    const session: RegistrySessionResult = {
      kind: "done",
      addedItems,
      items,
      failures,
      facts: completion.facts,
      output,
    };
    if (deployed !== undefined) session.deployed = deployed;
    return session;
  }

  return {
    add(item, title, itemOutput, setup = { facts: [] }) {
      addedItems.push(item);
      items.push({ address: item, title, facts: setup.facts, output: itemOutput });
      output.push(...itemOutput);
      currentItem = title;
      currentFacts = setup.facts;
      completion = mergeRegistrySetupCompletions(completion, setup);
    },

    addFailure(item, title, message, detail) {
      failures.push({ address: item, title, message, detail });
    },

    result,

    async continueAfterInstall(input) {
      if (completion.deploymentRequired !== true) return result();

      const deployment = await deps.detectDeployment(input.appRoot, { signal: input.signal });
      const canDeploy = deployment.state === "linked" || deployment.state === "deployed";
      input.prompter.replaceContent?.({
        headline: `Added ${currentItem}`,
        facts: currentFacts,
      });
      const allowAddMore = input.allowAddMore !== false;
      while (true) {
        const action = await input.prompter.select<"deploy" | "add-more" | "finish">({
          message: "What would you like to do next?",
          initialValue: allowAddMore ? "add-more" : "finish",
          hintLayout: "inline",
          options: [
            ...(allowAddMore ? [{ value: "add-more" as const, label: "Add more" }] : []),
            ...(canDeploy ? [{ value: "deploy" as const, label: "Deploy" }] : []),
            { value: "finish", label: allowAddMore ? "Finish" : "Start chatting" },
          ],
        });
        if (action === "add-more") {
          input.prompter.replaceContent?.();
          return "add-more";
        }
        if (action === "finish") return result();

        const confirmed = await input.prompter.select<"yes" | "back">({
          message: "Deploy to prod?",
          initialValue: "yes",
          options: [
            { value: "yes", label: "Yes" },
            { value: "back", label: "Back" },
          ],
        });
        if (confirmed === "back") continue;

        const deployResult = await deps.runDeployFlow({
          appRoot: input.appRoot,
          prompter: input.prompter,
          signal: input.signal,
          interactive: true,
        });
        return result(deployResult.kind === "deployed" ? "production" : undefined);
      }
    },
  };
}
