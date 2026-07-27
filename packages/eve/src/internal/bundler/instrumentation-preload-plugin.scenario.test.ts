import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { buildWithNitroRolldown } from "#internal/bundler/nitro-rolldown.js";
import { createInstrumentationPreloadPlugin } from "#internal/bundler/instrumentation-preload-plugin.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const execFileAsync = promisify(execFile);
const createScratchDirectory = useTemporaryDirectories();

const EXTERNAL_PACKAGE_NAME = "fake-db-driver";

/**
 * Writes an app whose entry imports an external package, mirroring how a
 * bundled Nitro server reaches a driver such as `pg`. The external records
 * whether instrumentation already ran when it was loaded, which is the
 * property the preload has to guarantee.
 */
function createScratchApp(directory: string): { entryPath: string; instrumentationPath: string } {
  const packageDirectory = join(directory, "node_modules", EXTERNAL_PACKAGE_NAME);
  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(
    join(packageDirectory, "package.json"),
    JSON.stringify({ name: EXTERNAL_PACKAGE_NAME, version: "1.0.0", type: "module" }),
  );
  writeFileSync(
    join(packageDirectory, "index.js"),
    "globalThis.__loadOrder.push(`external:${globalThis.__instrumented === true}`);\nexport const connect = () => undefined;\n",
  );

  const entryPath = join(directory, "entry.mjs");
  writeFileSync(
    entryPath,
    `import { connect } from "${EXTERNAL_PACKAGE_NAME}";\nglobalThis.__loadOrder.push("entry-body");\nexport default connect;\n`,
  );

  const instrumentationPath = join(directory, "instrumentation.mjs");
  writeFileSync(
    instrumentationPath,
    'globalThis.__instrumented = true;\nglobalThis.__loadOrder.push("instrumentation");\nexport default function installInstrumentationPlugin() {}\n',
  );

  return { entryPath, instrumentationPath };
}

async function bundleWithPreload(directory: string): Promise<string> {
  const { entryPath, instrumentationPath } = createScratchApp(directory);
  const outDir = join(directory, "out");

  await buildWithNitroRolldown({
    cwd: directory,
    input: entryPath,
    platform: "node",
    external: [EXTERNAL_PACKAGE_NAME],
    plugins: [createInstrumentationPreloadPlugin(instrumentationPath)],
    output: { dir: outDir, entryFileNames: "index.mjs", format: "esm", sourcemap: false },
  });

  return outDir;
}

describe("instrumentation preload (bundled)", () => {
  it("evaluates instrumentation before the entry's external imports", async () => {
    const directory = await createScratchDirectory("eve-instrumentation-preload-");
    const outDir = await bundleWithPreload(directory);

    // Node resolves the external from the scratch app's node_modules, so the
    // built entry runs the same way the hosted server would.
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `globalThis.__loadOrder = [];
         await import(${JSON.stringify(join(outDir, "index.mjs"))});
         console.log(JSON.stringify(globalThis.__loadOrder));`,
      ],
      { cwd: directory },
    );

    expect(JSON.parse(stdout.trim())).toEqual(["instrumentation", "external:true", "entry-body"]);
  });
});
