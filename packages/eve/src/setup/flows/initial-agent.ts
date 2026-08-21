import type { RegistryCatalogItem } from "#cli/commands/registry.js";
import type { Prompter, SelectOption } from "#setup/prompter.js";
import { WizardCancelledError } from "#setup/step.js";
import { withSpinner } from "#setup/with-spinner.js";

import { createRegistrySession, type RegistrySessionResult } from "./registry-session.js";

type Item = RegistryCatalogItem;
type Screen = "channels" | "integrations" | "review";
type Navigation = "next" | "back";

const SECTIONS = {
  channels: {
    title: "Where should people reach your agent?",
    description: "You can add more later with /add.",
    featured: ["channel/web", "channel/slack", "channel/github", "channel/linear-agent"],
    includes: (item: Item) => item.name.startsWith("channel/"),
  },
  integrations: {
    title: "What should your agent be able to work with?",
    featured: [
      "extension/github-tools",
      "connection/linear",
      "connection/notion",
      "connection/vercel",
      "extension/agent-browser",
    ],
    includes: (item: Item) =>
      !item.name.startsWith("channel/") && !item.name.startsWith("experimental/"),
  },
} as const;

const IMESSAGE = ["channel/photon-imessage", "channel/chat-sdk-linq", "channel/chat-sdk-sendblue"];

function label(item: Item): string {
  return item.title ?? item.name.split("/").at(-1) ?? item.name;
}

function rows(items: readonly Item[], selected: ReadonlySet<string>): SelectOption<string>[] {
  return items.map((item) => ({
    value: item.address,
    label: label(item),
    hint: item.description,
    checked: selected.has(item.address),
  }));
}

function featured(section: keyof typeof SECTIONS, catalog: readonly Item[]): Item[] {
  return SECTIONS[section].featured
    .map((name) => catalog.find((item) => item.name === name))
    .filter((item): item is Item => item !== undefined);
}

function isIMessageProvider(item: Item, catalog: readonly Item[]): boolean {
  return IMESSAGE.some(
    (name) => catalog.find((candidate) => candidate.name === name)?.address === item.address,
  );
}

async function chooseIMessage(
  prompter: Prompter,
  catalog: readonly Item[],
): Promise<string | undefined> {
  const providers = IMESSAGE.map((name) => catalog.find((item) => item.name === name)).filter(
    (item): item is Item => item !== undefined,
  );
  const choice = await prompter.select({
    message: "Add iMessage",
    description: "Choose the service that will connect your agent to iMessage.",
    options: [...rows(providers, new Set()), { value: "back", label: "Back" }],
  });
  return choice === "back" ? undefined : choice;
}

async function browsePlan(
  prompter: Prompter,
  section: keyof typeof SECTIONS,
  catalog: readonly Item[],
  selected: Set<string>,
): Promise<void> {
  const items = catalog.filter(SECTIONS[section].includes);
  while (true) {
    const choice = await prompter.select({
      message: section === "channels" ? "Add a channel" : "Add an integration",
      search: true,
      placeholder: section === "channels" ? "Search channels" : "Search integrations",
      hintLayout: "inline",
      options: [
        {
          value: "done",
          label: `Done · ${items.filter((item) => selected.has(item.address)).length} selected`,
          trailingAction: true,
        },
        ...rows(items, selected),
      ],
    });
    if (choice === "done") return;
    if (selected.has(choice)) selected.delete(choice);
    else selected.add(choice);
  }
}

async function editSection(input: {
  screen: Exclude<Screen, "review">;
  prompter: Prompter;
  catalog: readonly Item[];
  selected: Set<string>;
}): Promise<Navigation> {
  const { screen, catalog, prompter, selected } = input;
  const section = SECTIONS[screen];
  const featuredItems = featured(screen, catalog);
  let cursor: string | undefined;
  while (true) {
    const other = catalog.filter(
      (item) =>
        section.includes(item) &&
        !featuredItems.some((featuredItem) => featuredItem.address === item.address) &&
        !isIMessageProvider(item, catalog),
    );
    const otherSelected = other.filter((item) => selected.has(item.address));
    const provider = IMESSAGE.map((name) => catalog.find((item) => item.name === name)).find(
      (item) => item !== undefined && selected.has(item.address),
    );
    const choice = await prompter.select({
      message: section.title,
      ...("description" in section ? { description: section.description } : {}),
      initialValue: cursor,
      hintLayout: "inline",
      options: [
        ...rows(featuredItems, selected),
        ...(screen === "channels"
          ? [
              {
                value: "imessage",
                label: "iMessage…",
                hint: provider === undefined ? "Choose Photon, Linq, or Sendblue" : label(provider),
                checked: provider !== undefined,
              },
            ]
          : []),
        ...(otherSelected.length === 0
          ? [
              {
                value: "browse",
                label: `Browse all ${screen === "channels" ? "channels" : "integrations"}…`,
              },
            ]
          : [
              {
                value: "browse",
                label: "Other…",
                hint: otherSelected.map(label).join(", "),
                checked: true,
              },
            ]),
        ...(screen === "integrations"
          ? [{ value: "back", label: "Back", trailingAction: true }]
          : []),
        { value: "next", label: "Next", trailingAction: true },
      ],
    });
    cursor = choice;
    if (choice === "next") return "next";
    if (choice === "back") return "back";
    if (choice === "browse") {
      await browsePlan(prompter, screen, catalog, selected);
      continue;
    }
    if (choice === "imessage") {
      const providerAddress = await chooseIMessage(prompter, catalog);
      if (providerAddress !== undefined) {
        for (const name of IMESSAGE) {
          const item = catalog.find((candidate) => candidate.name === name);
          if (item !== undefined) selected.delete(item.address);
        }
        selected.add(providerAddress);
      }
      continue;
    }
    if (selected.has(choice)) selected.delete(choice);
    else selected.add(choice);
  }
}

async function editPlan(input: {
  prompter: Prompter;
  catalog: readonly Item[];
  selected: Set<string>;
}): Promise<"install" | "cancelled"> {
  let screen: Screen = "channels";
  while (true) {
    if (screen !== "review") {
      const navigation = await editSection({ ...input, screen });
      screen =
        navigation === "back" ? "channels" : screen === "channels" ? "integrations" : "review";
      continue;
    }
    if (input.selected.size === 0) return "install";
    const review = await input.prompter.select({
      message: "Review your agent",
      metadata: [...input.selected].map((address) => {
        const item = input.catalog.find((candidate) => candidate.address === address)!;
        return {
          label: item.name.startsWith("channel/") ? "Channel" : "Integration",
          value: label(item),
        };
      }),
      options: [
        { value: "install", label: "Install and set up" },
        { value: "back", label: "Back" },
      ],
    });
    if (review === "install") return "install";
    screen = "integrations";
  }
}

/** Collects and executes the initial agent plan before the first chat turn. */
export async function runInitialAgentSetupFlow(input: {
  appRoot: string;
  prompter: Prompter;
  signal?: AbortSignal;
  onItemStart?: (item: Item, index: number, total: number) => void;
  deps?: {
    browseRegistryCatalog: (typeof import("#cli/commands/registry.js"))["browseRegistryCatalog"];
    installRegistryItem: (typeof import("#cli/commands/registry.js"))["installRegistryItem"];
    detectDeployment: (typeof import("#setup/project-resolution.js"))["detectDeployment"];
    runDeployFlow: (typeof import("./deploy.js"))["runDeployFlow"];
  };
}): Promise<{ kind: "done"; result: RegistrySessionResult } | { kind: "cancelled" }> {
  try {
    const browseRegistryCatalog =
      input.deps?.browseRegistryCatalog ??
      (await import("#cli/commands/registry.js")).browseRegistryCatalog;
    const catalog = await withSpinner(input.prompter, "Loading registry…", () =>
      browseRegistryCatalog(input.appRoot),
    );
    const selected = new Set<string>();
    if (
      (await editPlan({ prompter: input.prompter, catalog: catalog.items, selected })) !== "install"
    )
      return { kind: "cancelled" };
    const detectDeployment =
      input.deps?.detectDeployment ??
      (await import("#setup/project-resolution.js")).detectDeployment;
    const runDeployFlow = input.deps?.runDeployFlow ?? (await import("./deploy.js")).runDeployFlow;
    const session = createRegistrySession({ detectDeployment, runDeployFlow });
    const install =
      input.deps?.installRegistryItem ?? (await import("#cli/commands/registry.js")).installRegistryItem;
    const items = [...selected].map((address) =>
      catalog.items.find((item) => item.address === address)!,
    );
    for (const [index, item] of items.entries()) {
      input.onItemStart?.(item, index, items.length);
      try {
        const installed = await (input.prompter.withExclusiveTerminal?.(() =>
          install(input.appRoot, item.address, {
            silent: true,
            prompter: input.prompter,
            signal: input.signal,
          }),
        ) ??
          install(input.appRoot, item.address, {
            silent: true,
            prompter: input.prompter,
            signal: input.signal,
          }));
        session.add(item.address, label(item), installed.output, installed.setup);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const detail = message.split("\n").find((line) => line.trim() !== "");
        const fullDetail = error instanceof Error ? error.stack ?? message : message;
        const action = await input.prompter.select({
          message: `Couldn't add ${label(item)}`,
          ...(detail === undefined ? {} : { description: detail }),
          options: [
            { value: "skip", label: `Skip ${label(item)}` },
            { value: "cancel", label: "Cancel setup" },
          ],
        });
        session.addFailure(
          item.address,
          label(item),
          detail ?? "Installation failed.",
          fullDetail,
        );
        if (action === "cancel") return { kind: "done", result: session.result() };
      }
    }
    const result = await session.continueAfterInstall({
      appRoot: input.appRoot,
      prompter: input.prompter,
      signal: input.signal,
      allowAddMore: false,
    });
    return { kind: "done", result: result === "add-more" ? session.result() : result };
  } catch (error) {
    if (error instanceof WizardCancelledError) return { kind: "cancelled" };
    throw error;
  }
}
