import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker } from "#setup/ask.js";

import { SetupPrerequisiteRequired } from "./prerequisite.js";
import { createIntegrationSetupUi } from "./ui.js";
import { resolveIntegrationVercelProject } from "./vercel-project.js";

function ui(interaction: "interactive" | "headless") {
  return createIntegrationSetupUi({
    asker: headlessAsker(),
    prompter: createFakePrompter().prompter,
    interaction,
  });
}

describe("resolveIntegrationVercelProject", () => {
  it("lets interactive setup ensure the project inline", async () => {
    const ensureVercelProject = vi.fn(async () => ({ orgId: "org-id", projectId: "project-id" }));
    const readProjectLink = vi.fn();

    await expect(
      resolveIntegrationVercelProject({
        appRoot: "/project",
        integration: "Photon",
        ui: ui("interactive"),
        deps: { ensureVercelProject, readProjectLink },
      }),
    ).resolves.toEqual({ orgId: "org-id", projectId: "project-id" });

    expect(ensureVercelProject).toHaveBeenCalledOnce();
    expect(readProjectLink).not.toHaveBeenCalled();
  });

  it("only reads an existing link for headless setup", async () => {
    const ensureVercelProject = vi.fn();
    const readProjectLink = vi.fn(async () => ({ orgId: "org-id", projectId: "project-id" }));

    await expect(
      resolveIntegrationVercelProject({
        appRoot: "/project",
        integration: "Slack",
        ui: ui("headless"),
        deps: { ensureVercelProject, readProjectLink },
      }),
    ).resolves.toEqual({ orgId: "org-id", projectId: "project-id" });

    expect(ensureVercelProject).not.toHaveBeenCalled();
  });

  it("returns a typed prerequisite when headless setup is unlinked", async () => {
    await expect(
      resolveIntegrationVercelProject({
        appRoot: "/project",
        integration: "Slack",
        ui: ui("headless"),
        deps: { ensureVercelProject: vi.fn(), readProjectLink: vi.fn(async () => undefined) },
      }),
    ).rejects.toMatchObject({
      name: "SetupPrerequisiteRequired",
      code: "vercel-project-link",
      command: "eve link",
      message: expect.stringContaining("retry Slack setup"),
    } satisfies Partial<SetupPrerequisiteRequired>);
  });
});
