import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, InteractionRequired, withAnswers } from "#setup/ask.js";
import type { SlackConnectorSlug } from "#setup/scaffold/index.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { setupSlack, type SlackSetupDeps } from "./setup.js";

function channelResult() {
  return {
    kind: "slack" as const,
    action: "created" as const,
    filesWritten: [],
    filesOverwritten: [],
    filesSkipped: [],
    packageJsonUpdated: [],
    slackConnectorSlug: "agent" as SlackConnectorSlug,
  };
}

function deps(): SlackSetupDeps {
  return {
    deriveSlackConnectorSlug: vi.fn(async () => "agent" as SlackConnectorSlug),
    ensureChannel: vi.fn(async () => channelResult()),
    ensureVercelProject: vi.fn(async () => ({ orgId: "org-id", projectId: "project-id" })),
    readProjectLink: vi.fn(async () => ({ orgId: "org-id", projectId: "project-id" })),
    provisionSlackbot: vi.fn(async () => ({
      state: "attached" as const,
      connectorUid: "slack/agent",
    })),
    reconcileSlackUid: vi.fn(),
  };
}

function run(input: {
  answers?: Record<string, unknown>;
  effects?: SlackSetupDeps;
  yes?: boolean;
  interaction?: "interactive" | "headless";
}) {
  const effects = input.effects ?? deps();
  const interaction = input.interaction ?? "headless";
  return {
    effects,
    result: setupSlack(
      {
        appRoot: "/project",
        environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({
          asker: withAnswers(input.answers ?? {})(headlessAsker()),
          prompter: createFakePrompter().prompter,
          interaction,
        }),
        yes: input.yes,
      },
      effects,
    ),
  };
}

describe("setupSlack", () => {
  it("uses Vercel Connect without asking for credentials with --yes", async () => {
    const { effects, result } = run({ yes: true, interaction: "interactive" });

    await expect(result).resolves.toMatchObject({ kind: "done" });
    expect(effects.provisionSlackbot).toHaveBeenCalledOnce();
  });

  it("scaffolds portable credentials entirely from one keyed answer", async () => {
    const { effects, result } = run({ answers: { "slack-credentials": "portable" } });

    await expect(result).resolves.toMatchObject({ kind: "done" });
    expect(effects.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({ slackCredentials: "environment" }),
    );
    expect(effects.ensureVercelProject).not.toHaveBeenCalled();
    expect(effects.readProjectLink).not.toHaveBeenCalled();
    expect(effects.provisionSlackbot).not.toHaveBeenCalled();
  });

  it("refuses a missing credential answer before mutation", async () => {
    const { effects, result } = run({});

    await expect(result).rejects.toBeInstanceOf(InteractionRequired);
    expect(effects.deriveSlackConnectorSlug).not.toHaveBeenCalled();
    expect(effects.ensureChannel).not.toHaveBeenCalled();
    expect(effects.provisionSlackbot).not.toHaveBeenCalled();
  });

  it("requires an existing project link headlessly before Slack provisioning", async () => {
    const effects = deps();
    vi.mocked(effects.readProjectLink).mockResolvedValue(undefined);
    const { result } = run({ effects, answers: { "slack-credentials": "vercel" } });

    await expect(result).rejects.toThrow("Run `eve link`");
    expect(effects.ensureVercelProject).not.toHaveBeenCalled();
    expect(effects.provisionSlackbot).not.toHaveBeenCalled();
    expect(effects.ensureChannel).not.toHaveBeenCalled();
  });

  it("answers dynamic connector discovery by stable UID", async () => {
    const connector = { id: "scl_existing", uid: "slack/existing" };
    const effects = deps();
    effects.provisionSlackbot = vi.fn(async (_log, _root, _slug, _deps, options) => {
      expect(await options?.selectConnector?.([connector], connector)).toBe(connector);
      return { state: "attached", connectorUid: connector.uid };
    }) as SlackSetupDeps["provisionSlackbot"];

    await run({
      effects,
      answers: {
        "slack-credentials": "vercel",
        "slack-connector": connector.uid,
      },
    }).result;

    expect(effects.provisionSlackbot).toHaveBeenCalledOnce();
  });
});
