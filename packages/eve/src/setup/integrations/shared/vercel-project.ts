import { ensureVercelProject } from "#setup/flows/ensure-vercel-project.js";
import { readProjectLink, type VercelProjectReference } from "#setup/project-resolution.js";

import { SetupPrerequisiteRequired } from "./prerequisite.js";
import type { IntegrationSetupUi } from "./ui.js";

export interface IntegrationVercelProjectDeps {
  ensureVercelProject: typeof ensureVercelProject;
  readProjectLink: typeof readProjectLink;
}

const defaultDeps: IntegrationVercelProjectDeps = { ensureVercelProject, readProjectLink };

/** Resolves inline for people, but treats linking as a separate prerequisite for headless setup. */
export async function resolveIntegrationVercelProject(input: {
  appRoot: string;
  integration: string;
  ui: IntegrationSetupUi;
  signal?: AbortSignal;
  deps?: IntegrationVercelProjectDeps;
}): Promise<VercelProjectReference> {
  const deps = input.deps ?? defaultDeps;
  const project =
    input.ui.interaction === "interactive"
      ? await deps.ensureVercelProject({
          appRoot: input.appRoot,
          prompter: input.ui.prompter,
          signal: input.signal,
        })
      : await deps.readProjectLink(input.appRoot);
  if (project !== undefined) return project;

  throw new SetupPrerequisiteRequired({
    code: "vercel-project-link",
    message: `Vercel Connect setup requires a linked Vercel project. Run \`eve link\`, then retry ${input.integration} setup.`,
    command: "eve link",
  });
}
