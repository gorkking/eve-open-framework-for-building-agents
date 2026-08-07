import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker } from "#setup/ask.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { setupWeb, type WebSetupDeps } from "./setup.js";

function deps(): WebSetupDeps {
  return {
    detectPackageManager: vi.fn(async () => ({
      kind: "pnpm" as const,
      source: "lockfile" as const,
    })),
    ensureChannel: vi.fn(async () => ({
      kind: "web" as const,
      action: "created" as const,
      filesWritten: [],
      filesOverwritten: [],
      filesSkipped: [],
      packageJsonUpdated: [
        { path: "/project/package.json", dependencies: ["eve"], devDependencies: [], scripts: [] },
      ],
      nodeEngineOverride: undefined,
      competingNextConfigFiles: [],
    })),
    installScaffoldDependencies: vi.fn(async () => {}),
  };
}

describe("Web setup", () => {
  it("runs headlessly without asking any semantic questions", async () => {
    const effects = deps();

    await expect(
      setupWeb(
        {
          appRoot: "/project",
          environment: integrationSetupEnvironment("cli-missing", { kind: "unresolved" }),
          ui: createIntegrationSetupUi({
            asker: headlessAsker(),
            prompter: createFakePrompter().prompter,
            interaction: "headless",
          }),
        },
        effects,
      ),
    ).resolves.toMatchObject({ kind: "done" });

    expect(effects.ensureChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        projectRoot: "/project",
        configureVercelServices: false,
        skipDependencyMutation: true,
      }),
    );
    expect(effects.installScaffoldDependencies).toHaveBeenCalledWith(
      expect.objectContaining({ changed: true, projectPath: "/project" }),
    );
  });
});
