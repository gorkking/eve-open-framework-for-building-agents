import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolvePackageRoot, resolveWorkflowModulePath } from "#internal/application/package.js";

import { bundleFinalWorkflowOutput, bundleWorkflowStepRegistrations } from "./builder-support.js";

describe("bundleFinalWorkflowOutput", () => {
  it("writes the intermediate wrapper against the namespaced eve Workflow runtime facade", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eve-workflow-runtime-facade-"));
    const target = join(dir, "workflows.mjs");

    try {
      await bundleFinalWorkflowOutput({
        code: "globalThis.__private_workflows = new Map();",
        outfile: target,
        queueNamespace: "evetest",
        stepRegistrationsPath: join(dir, "steps.mjs"),
        workingDir: resolvePackageRoot(),
      });

      const source = await readFile(target, "utf8");
      const runtimePath = resolveWorkflowModulePath("workflow/runtime").replaceAll("\\", "/");
      expect(source).toContain(`from ${JSON.stringify(runtimePath)}`);
      expect(source).toContain('Buffer.from(["');
      expect(source).not.toContain("const workflowCode = `");
      expect(source).toContain('workflowEntrypoint(workflowCode, { namespace: "evetest" })');
      expect(source).toContain(
        'import { __steps_registered as __eveWorkflowStepsRegistered } from "./steps.mjs";',
      );
      expect(source).toContain("void __eveWorkflowStepsRegistered;");
      expect(source).not.toContain('from "workflow/runtime"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("omits inline source maps from executable step registrations", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eve-workflow-step-registrations-"));
    const stepPath = join(dir, "ping.ts");
    const target = join(dir, "steps.mjs");

    try {
      await writeFile(
        stepPath,
        ["export async function ping() {", '  "use step";', '  return "pong";', "}", ""].join("\n"),
      );
      await bundleWorkflowStepRegistrations({
        builtinsPath: resolveWorkflowModulePath("workflow/internal/builtins"),
        discoveredEntries: {
          discoveredSerdeFiles: [],
          discoveredSteps: [stepPath],
          discoveredWorkflows: [],
        },
        outfile: target,
        projectRoot: dir,
        workingDir: resolvePackageRoot(),
      });

      const source = await readFile(target, "utf8");
      expect(source).toContain("__steps_registered");
      expect(source).not.toContain("sourceMappingURL=data:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
