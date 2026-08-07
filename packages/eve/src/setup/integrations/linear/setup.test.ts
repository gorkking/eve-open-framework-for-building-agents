import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import { headlessAsker, withAnswers, withPolicy } from "#setup/ask.js";

import { integrationSetupEnvironment } from "../shared/environment.js";
import { createIntegrationSetupUi } from "../shared/ui.js";
import { linearSafeConnectorSlug, setupLinear, type LinearSetupDeps } from "./setup.js";

function deps(): LinearSetupDeps {
  return {
    attachConnector: vi.fn(async () => {}),
    deriveConnectorSlug: vi.fn(async () => "agent" as never),
    ensureVercelProject: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    readProjectLink: vi.fn(async () => ({ orgId: "team-id", projectId: "project-id" })),
    findConnector: vi.fn(async () => undefined),
    provisionConnector: vi.fn(async () => ({ id: "scl_linear", uid: "linear/agent" })),
    writeTextFile: vi.fn(async () => {}),
  };
}

function run(input: { answers?: Record<string, unknown>; effects?: LinearSetupDeps }) {
  const effects = input.effects ?? deps();
  return {
    effects,
    result: setupLinear(
      {
        appRoot: "/project",
        environment: integrationSetupEnvironment("authenticated", { kind: "unresolved" }),
        ui: createIntegrationSetupUi({
          asker: withAnswers(input.answers ?? {})(withPolicy("assume")(headlessAsker())),
          prompter: createFakePrompter().prompter,
          interaction: "headless",
        }),
      },
      effects,
    ),
  };
}

describe("Linear setup", () => {
  it("removes Linear from managed app names", () => {
    expect(linearSafeConnectorSlug("eve-linear-agent")).toBe("eve-agent");
    expect(linearSafeConnectorSlug("linear")).toBe("agent");
  });

  it("provisions and scaffolds from recommended keyed choices", async () => {
    const { effects, result } = run({});

    await expect(result).resolves.toMatchObject({ kind: "done" });
    expect(effects.provisionConnector).toHaveBeenCalledWith(
      expect.objectContaining({ slug: "agent" }),
    );
    expect(effects.writeTextFile).toHaveBeenCalledWith(
      "/project/agent/channels/linear.ts",
      expect.stringContaining('connectLinearCredentials("linear/agent")'),
      { force: undefined },
    );
  });

  it("reuses an existing connector selected by stable answer", async () => {
    const effects = deps();
    vi.mocked(effects.findConnector).mockResolvedValue({ id: "scl_existing", uid: "linear/agent" });
    const { result } = run({
      effects,
      answers: { "linear.existing-connector": "reuse" },
    });

    await expect(result).resolves.toMatchObject({ kind: "done" });
    expect(effects.attachConnector).toHaveBeenCalledWith(
      expect.objectContaining({ connector: { id: "scl_existing", uid: "linear/agent" } }),
    );
    expect(effects.provisionConnector).not.toHaveBeenCalled();
  });

  it("requires an existing Vercel link headlessly before mutation", async () => {
    const effects = deps();
    vi.mocked(effects.readProjectLink).mockResolvedValue(undefined);
    const { result } = run({ effects });

    await expect(result).rejects.toThrow("Run `eve link`");
    expect(effects.ensureVercelProject).not.toHaveBeenCalled();
    expect(effects.findConnector).not.toHaveBeenCalled();
    expect(effects.provisionConnector).not.toHaveBeenCalled();
    expect(effects.writeTextFile).not.toHaveBeenCalled();
  });

  it("requires an authenticated Vercel CLI", async () => {
    await expect(
      setupLinear({
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
