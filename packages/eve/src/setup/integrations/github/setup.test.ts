import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, InteractionRequired, withAnswers } from "#setup/ask.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { setupGitHub, type GitHubSetupDeps } from "./setup.js";

const DEFAULT_EVENTS = ["issue_comment", "pull_request_review_comment"];

function deps(): GitHubSetupDeps {
  return {
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    ensureVercelProject: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    readProjectLink: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    provisionConnector: vi.fn(async () => ({
      appSlug: "agent",
      id: "scl_github",
      uid: "github/agent",
    })),
    writeTextFile: vi.fn(async () => {}),
  };
}

function run(input: { events?: string[]; effects?: GitHubSetupDeps }) {
  const effects = input.effects ?? deps();
  return {
    effects,
    result: setupGitHub(
      {
        appRoot: "/project",
        environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({
          asker: withAnswers({ "github-events": input.events ?? DEFAULT_EVENTS })(headlessAsker()),
          prompter: createFakePrompter().prompter,
          interaction: "headless",
        }),
      },
      effects,
    ),
  };
}

describe("GitHub setup", () => {
  it("provisions and scaffolds selected events from a keyed answer", async () => {
    const events = ["issue_comment", "issues", "pull_request"];
    const { effects, result } = run({ events });

    await expect(result).resolves.toMatchObject({ kind: "done" });
    expect(effects.provisionConnector).toHaveBeenCalledWith(expect.objectContaining({ events }));
    const scaffold = vi.mocked(effects.writeTextFile).mock.calls[0]?.[1] ?? "";
    expect(scaffold).toContain('connectGitHubCredentials("github/agent")');
    expect(scaffold).toContain('botName: "agent"');
    expect(scaffold).toContain("onIssue(ctx, issue)");
    expect(scaffold).toContain("onPullRequest(ctx, pullRequest)");
  });

  it("refuses a missing event answer before mutation", async () => {
    const effects = deps();
    const result = setupGitHub(
      {
        appRoot: "/project",
        environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({
          asker: headlessAsker(),
          prompter: createFakePrompter().prompter,
          interaction: "headless",
        }),
      },
      effects,
    );

    await expect(result).rejects.toBeInstanceOf(InteractionRequired);
    expect(effects.readProjectLink).not.toHaveBeenCalled();
    expect(effects.provisionConnector).not.toHaveBeenCalled();
  });

  it("requires an existing Vercel link headlessly before mutation", async () => {
    const effects = deps();
    vi.mocked(effects.readProjectLink).mockResolvedValue(undefined);
    const { result } = run({ effects });

    await expect(result).rejects.toThrow("Run `eve link`");
    expect(effects.ensureVercelProject).not.toHaveBeenCalled();
    expect(effects.provisionConnector).not.toHaveBeenCalled();
    expect(effects.writeTextFile).not.toHaveBeenCalled();
  });

  it("requires an authenticated Vercel CLI", async () => {
    await expect(
      setupGitHub({
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
