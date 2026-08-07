import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, InteractionRequired, withAnswers } from "#setup/ask.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { setupDiscord, type DiscordSetupDeps } from "./setup.js";

const ANSWERS = {
  "discord-bot-token": "  bot-token  ",
  "discord-command-name": "ask",
  "discord-command-description": "Ask the eve agent",
};

function deps(): DiscordSetupDeps {
  return {
    configureEndpoint: vi.fn(async () => {}),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    ensureVercelProject: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    readProjectLink: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    provisionConnector: vi.fn(async () => ({ id: "scl_discord", uid: "discord/agent" })),
    registerCommand: vi.fn(async () => {}),
    resolveApplication: vi.fn(async () => ({ id: "app-1", name: "Agent", publicKey: "key" })),
    writeTextFile: vi.fn(async () => {}),
  };
}

function run(input: { answers?: Record<string, unknown>; effects?: DiscordSetupDeps }) {
  const effects = input.effects ?? deps();
  return {
    effects,
    result: setupDiscord(
      {
        appRoot: "/project",
        environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({
          asker: withAnswers(input.answers ?? ANSWERS)(headlessAsker()),
          prompter: createFakePrompter().prompter,
          interaction: "headless",
        }),
      },
      effects,
    ),
  };
}

describe("Discord setup", () => {
  it("provisions and scaffolds entirely from keyed answers", async () => {
    const { effects, result } = run({});

    await expect(result).resolves.toMatchObject({ kind: "done" });
    expect(effects.resolveApplication).toHaveBeenCalledWith("bot-token");
    expect(effects.provisionConnector).toHaveBeenCalledWith(
      expect.objectContaining({ botToken: "bot-token" }),
    );
    expect(effects.registerCommand).toHaveBeenCalledWith("app-1", "bot-token", {
      name: "ask",
      description: "Ask the eve agent",
    });
    expect(effects.configureEndpoint).toHaveBeenCalledWith("bot-token", "scl_discord");
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/discord.ts",
      expect.stringContaining('connectDiscordCredentials("discord/agent")'),
      { force: undefined },
    );
  });

  it("refuses a missing required answer before mutation", async () => {
    const { effects, result } = run({ answers: {} });

    await expect(result).rejects.toBeInstanceOf(InteractionRequired);
    expect(effects.resolveApplication).not.toHaveBeenCalled();
    expect(effects.ensureVercelProject).not.toHaveBeenCalled();
    expect(effects.provisionConnector).not.toHaveBeenCalled();
  });

  it("requires an existing Vercel link headlessly before remote mutation", async () => {
    const effects = deps();
    vi.mocked(effects.readProjectLink).mockResolvedValue(undefined);
    const { result } = run({ effects });

    await expect(result).rejects.toThrow("Run `eve link`");
    expect(effects.ensureVercelProject).not.toHaveBeenCalled();
    expect(effects.provisionConnector).not.toHaveBeenCalled();
    expect(effects.registerCommand).not.toHaveBeenCalled();
    expect(effects.writeTextFile).not.toHaveBeenCalled();
  });

  it("requires an authenticated Vercel CLI", async () => {
    await expect(
      setupDiscord({
        appRoot: "/project",
        environment: integrationSetupEnvironment("logged-out", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({
          asker: headlessAsker(),
          prompter: createFakePrompter().prompter,
          interaction: "headless",
        }),
      }),
    ).rejects.toThrow("vercel login");
  });
});
