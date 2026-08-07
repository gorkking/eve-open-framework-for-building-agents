import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, InteractionRequired, interactiveAsker, withAnswers } from "#setup/ask.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { setupPhoton, type PhotonSetupDeps, type PhotonSetupOptions } from "./setup-flow.js";

const PORTABLE_ANSWERS = {
  "photon-credentials": "portable",
  "photon-project-source": "create",
  "photon-project-name": "eve · agent",
  "photon-phone-number": "+15551234567",
};

function deps(): PhotonSetupDeps {
  return {
    appendEnv: vi.fn(async () => ({ written: [], skipped: [] })),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    ensureVercelProject: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    readProjectLink: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    openUrl: vi.fn(),
    provisionConnector: vi.fn(async () => ({ id: "connector-id", uid: "photon/agent" })),
    provisionProject: vi.fn(async () => ({
      projectId: "project-id",
      projectSecret: "project-secret",
      cleanup: vi.fn(async () => {}),
    })),
    useProject: vi.fn(),
    writeTextFile: vi.fn(async () => {}),
  };
}

function run(input: {
  answers?: Record<string, unknown>;
  effects?: PhotonSetupDeps;
  auth?: "authenticated" | "cli-missing";
  interaction?: "interactive" | "headless";
  ui?: PhotonSetupOptions["ui"];
  agentName?: string;
}) {
  const effects = input.effects ?? deps();
  const interaction = input.interaction ?? "headless";
  const prompter = createFakePrompter().prompter;
  const ui =
    input.ui ??
    createIntegrationSetupUi({
      asker: withAnswers(input.answers ?? PORTABLE_ANSWERS)(headlessAsker()),
      prompter,
      interaction,
    });
  return {
    effects,
    result: setupPhoton({
      agentName: input.agentName ?? "agent",
      projectPath: "/project",
      environment: integrationSetupEnvironment(input.auth ?? "authenticated", {
        kind: "unresolved",
      }),
      ui,
      deps: effects,
    }),
  };
}

function expectNoMutation(effects: PhotonSetupDeps): void {
  for (const effect of [
    effects.ensureVercelProject,
    effects.readProjectLink,
    effects.provisionProject,
    effects.useProject,
    effects.provisionConnector,
    effects.appendEnv,
    effects.writeTextFile,
  ]) {
    expect(effect).not.toHaveBeenCalled();
  }
}

describe("Photon setup", () => {
  it("scaffolds portable credentials entirely from keyed answers", async () => {
    const { effects, result } = run({
      auth: "cli-missing",
      answers: { ...PORTABLE_ANSWERS, "photon-project-name": "Agent Messages" },
    });

    await expect(result).resolves.toMatchObject({ kind: "done" });
    expect(effects.provisionProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: "Agent Messages", phoneNumber: "+15551234567" }),
    );
    expect(effects.appendEnv).toHaveBeenCalledWith("/project/.env.local", {
      IMESSAGE_PROJECT_ID: "project-id",
      IMESSAGE_PROJECT_SECRET: "project-secret",
    });
    expect(effects.provisionConnector).not.toHaveBeenCalled();
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/photon.ts",
      expect.stringContaining("IMESSAGE_WEBHOOK_SECRET"),
      { force: undefined },
    );
  });

  it("rejects Connect without Vercel authentication", async () => {
    const { result } = run({
      auth: "cli-missing",
      answers: { "photon-credentials": "vercel" },
    });

    await expect(result).rejects.toThrow("vercel login");
  });

  it("collects every Photon decision before mutation", async () => {
    const { effects, result } = run({
      answers: {
        "photon-credentials": "portable",
        "photon-project-source": "create",
      },
    });

    await expect(result).rejects.toBeInstanceOf(InteractionRequired);
    expectNoMutation(effects);
  });

  it("preserves the one-screen editable project picker interactively", async () => {
    const answers: Record<string, string> = {
      "How would you like to configure Photon?": "portable",
      "Your iMessage phone number": "+15551234567",
    };
    const fake = createFakePrompter({
      single: (options) => answers[options.message]!,
      text: (options) => answers[options.message]!,
    });
    fake.prompter.selectEditable = async <T>() => ({
      kind: "edited" as const,
      value: "create" as T,
      text: "My Photon project",
    });
    const selectEditable = vi.spyOn(fake.prompter, "selectEditable");
    const effects = deps();

    await run({
      auth: "cli-missing",
      effects,
      interaction: "interactive",
      ui: createIntegrationSetupUi({
        asker: interactiveAsker(fake.prompter),
        prompter: fake.prompter,
      }),
    }).result;

    expect(fake.selectMessages).toEqual(["How would you like to configure Photon?"]);
    expect(selectEditable).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Photon project" }),
    );
    expect(effects.provisionProject).toHaveBeenCalledWith(
      expect.objectContaining({ projectName: "My Photon project" }),
    );
  });

  it("requires an existing Vercel link headlessly before Photon mutation", async () => {
    const effects = deps();
    vi.mocked(effects.readProjectLink).mockResolvedValue(undefined);
    const { result } = run({
      effects,
      answers: { ...PORTABLE_ANSWERS, "photon-credentials": "vercel" },
    });

    await expect(result).rejects.toThrow("Run `eve link`");
    expect(effects.ensureVercelProject).not.toHaveBeenCalled();
    expect(effects.provisionProject).not.toHaveBeenCalled();
  });

  it("links Vercel interactively before creating a Photon project", async () => {
    const order: string[] = [];
    const effects = deps();
    vi.mocked(effects.ensureVercelProject).mockImplementation(async () => {
      order.push("vercel");
      return { orgId: "team-id", projectId: "project-id" };
    });
    vi.mocked(effects.provisionProject).mockImplementation(async () => {
      order.push("photon");
      return {
        projectId: "project-id",
        projectSecret: "project-secret",
        cleanup: vi.fn(async () => {}),
      };
    });

    await run({
      effects,
      interaction: "interactive",
      answers: { ...PORTABLE_ANSWERS, "photon-credentials": "vercel" },
    }).result;

    expect(order).toEqual(["vercel", "photon"]);
  });
});
