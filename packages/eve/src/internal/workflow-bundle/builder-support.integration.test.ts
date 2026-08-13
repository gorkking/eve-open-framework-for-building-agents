import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolvePackageRoot, resolveWorkflowModulePath } from "#internal/application/package.js";

import { bundleFinalWorkflowOutput, bundleWorkflowStepRegistrations } from "./builder-support.js";

const REQUIRE_EXPORT_MARKER = "eve-step-conditional-require-export";
const IMPORT_EXPORT_MARKER = "eve-step-conditional-import-export";

async function writeConditionalRequirePackages(root: string): Promise<void> {
  const parentRoot = join(root, "node_modules", "cjs-parent");
  const baseRoot = join(root, "node_modules", "conditional-base");
  await Promise.all([mkdir(parentRoot, { recursive: true }), mkdir(baseRoot, { recursive: true })]);
  await Promise.all([
    writeFile(
      join(parentRoot, "index.cjs"),
      'const Base = require("conditional-base");\nmodule.exports = class Child extends Base {};\n',
    ),
    writeFile(
      join(parentRoot, "package.json"),
      `${JSON.stringify({ main: "./index.cjs", name: "cjs-parent", version: "1.0.0" })}\n`,
    ),
    writeFile(
      join(baseRoot, "import.mjs"),
      `export default { source: ${JSON.stringify(IMPORT_EXPORT_MARKER)} };\n`,
    ),
    writeFile(
      join(baseRoot, "package.json"),
      `${JSON.stringify({
        exports: { ".": { import: "./import.mjs", require: "./require.cjs" } },
        name: "conditional-base",
        type: "module",
        version: "1.0.0",
      })}\n`,
    ),
    writeFile(
      join(baseRoot, "require.cjs"),
      `module.exports = class Base { constructor() { this.source = ${JSON.stringify(REQUIRE_EXPORT_MARKER)}; } };\n`,
    ),
  ]);
}

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

  it("preserves require exports in step CommonJS dependencies", async () => {
    const dir = await mkdtemp(join(tmpdir(), "eve-workflow-step-conditions-"));
    const stepPath = join(dir, "conditional.ts");
    const target = join(dir, "steps.mjs");

    try {
      await writeConditionalRequirePackages(dir);
      await writeFile(
        stepPath,
        [
          'import Child from "cjs-parent";',
          "export async function conditional() {",
          '  "use step";',
          "  return new Child().source;",
          "}",
          "",
        ].join("\n"),
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
      expect(source).toContain(REQUIRE_EXPORT_MARKER);
      expect(source).not.toContain(IMPORT_EXPORT_MARKER);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
