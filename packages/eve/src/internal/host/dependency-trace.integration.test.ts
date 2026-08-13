import { access, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { traceServerDependencies } from "#internal/host/dependency-trace.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createTemporaryDirectory = useTemporaryDirectories();

describe("traceServerDependencies", () => {
  it("emits a deployable trace from pnpm links, explicit externals, and package conditions", async () => {
    const root = await createTemporaryDirectory("eve-dependency-trace-");
    const appRoot = join(root, "app");
    const packageRoot = join(root, "eve");
    const outputDirectory = join(appRoot, ".eve", "build", "server");
    const serverEntryPath = join(outputDirectory, "index.mjs");

    const nativeLink = await writePnpmLinkedPackage(appRoot, {
      files: {
        "binding.node": "native-addon-placeholder\n",
        "index.mjs": 'export const nativeMarker = "native-ok";\n',
      },
      name: "fixture-native",
      packageJson: {
        exports: "./index.mjs",
        gypfile: true,
        type: "module",
      },
      version: "1.2.3",
    });
    await writePnpmLinkedPackage(appRoot, {
      files: {
        "condition.mjs": 'export const selected = "condition";\n',
        "default.mjs": 'export const selected = "default";\n',
      },
      name: "fixture-conditional",
      packageJson: {
        exports: {
          ".": {
            "eve-trace-test": "./condition.mjs",
            default: "./default.mjs",
          },
        },
        type: "module",
      },
      version: "2.0.0",
    });
    await writePnpmLinkedPackage(packageRoot, {
      files: {
        "index.mjs": 'export const engine = "engine-ok";\n',
      },
      name: "@fixture/engine",
      packageJson: {
        exports: "./index.mjs",
        type: "module",
      },
      version: "3.1.0",
    });
    await writePnpmLinkedPackage(appRoot, {
      files: {
        "index.mjs": 'export const unreported = "entry-only";\n',
      },
      name: "fixture-entry-only",
      packageJson: {
        exports: "./index.mjs",
        type: "module",
      },
      version: "4.0.0",
    });

    expect((await lstat(nativeLink)).isSymbolicLink()).toBe(true);

    await mkdir(outputDirectory, { recursive: true });
    await writeFile(serverEntryPath, 'import "fixture-entry-only";\nexport default {};\n', "utf8");

    const result = await traceServerDependencies({
      appRoot,
      conditions: ["node", "eve-trace-test", "import", "default"],
      configuredExternalDependencies: [
        "fixture-native",
        "fixture-conditional",
        "fixture-conditional",
      ],
      outputDirectory,
      packageRoot,
      sandboxEngineExternalDependencies: ["@fixture/engine"],
      serverEntryPath,
    });

    await expectFile(join(outputDirectory, "node_modules", "fixture-native", "index.mjs"));
    await expectFile(join(outputDirectory, "node_modules", "fixture-native", "binding.node"));
    await expectFile(join(outputDirectory, "node_modules", "fixture-conditional", "condition.mjs"));
    await expect(
      access(join(outputDirectory, "node_modules", "fixture-conditional", "default.mjs")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expectFile(join(outputDirectory, "node_modules", "@fixture", "engine", "index.mjs"));
    await expect(
      access(join(outputDirectory, "node_modules", "fixture-entry-only")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const packageJson = JSON.parse(await readFile(result.packageJsonPath, "utf8")) as {
      readonly dependencies: Readonly<Record<string, string>>;
      readonly type: string;
    };
    expect(packageJson).toMatchObject({
      dependencies: {
        "@fixture/engine": "3.1.0",
        "fixture-conditional": "2.0.0",
        "fixture-native": "1.2.3",
      },
      type: "module",
    });
    expect(result.conditions).toEqual(["node", "eve-trace-test", "import", "default"]);
    expect(result.packages).toEqual([
      { name: "@fixture/engine", versions: ["3.1.0"] },
      { name: "fixture-conditional", versions: ["2.0.0"] },
      { name: "fixture-native", versions: ["1.2.3"] },
    ]);
    expect(result.nodeModulesDirectory).toBe(join(outputDirectory, "node_modules"));
    expect(result.warnings).toEqual([]);

    await rm(join(appRoot, "node_modules"), { force: true, recursive: true });
    const deployedNativePackage = (await import(
      pathToFileURL(join(outputDirectory, "node_modules", "fixture-native", "index.mjs")).href
    )) as { readonly nativeMarker: string };
    expect(deployedNativePackage.nativeMarker).toBe("native-ok");
  });

  it("fails before tracing when an explicit external package cannot be resolved", async () => {
    const root = await createTemporaryDirectory("eve-dependency-trace-missing-");
    const appRoot = join(root, "app");
    const packageRoot = join(root, "eve");
    const outputDirectory = join(appRoot, "output");
    const serverEntryPath = join(outputDirectory, "index.mjs");

    await mkdir(outputDirectory, { recursive: true });
    await mkdir(packageRoot, { recursive: true });
    await writeFile(serverEntryPath, "export default {};\n", "utf8");

    await expect(
      traceServerDependencies({
        appRoot,
        configuredExternalDependencies: ["missing-package"],
        outputDirectory,
        packageRoot,
        sandboxEngineExternalDependencies: [],
        serverEntryPath,
      }),
    ).rejects.toThrow(
      'Cannot trace external dependency "missing-package": package "missing-package" was not found',
    );
  });

  it("rejects an entry outside the output directory", async () => {
    const root = await createTemporaryDirectory("eve-dependency-trace-boundary-");
    const appRoot = join(root, "app");
    const packageRoot = join(root, "eve");
    const outputDirectory = join(appRoot, "output");
    const serverEntryPath = join(appRoot, "index.mjs");

    await mkdir(outputDirectory, { recursive: true });
    await mkdir(packageRoot, { recursive: true });
    await writeFile(serverEntryPath, "export default {};\n", "utf8");

    await expect(
      traceServerDependencies({
        appRoot,
        configuredExternalDependencies: [],
        outputDirectory,
        packageRoot,
        sandboxEngineExternalDependencies: [],
        serverEntryPath,
      }),
    ).rejects.toThrow("Emitted server entry must be inside its output directory");
  });
});

async function writePnpmLinkedPackage(
  root: string,
  input: {
    readonly files: Readonly<Record<string, string>>;
    readonly name: string;
    readonly packageJson: Readonly<Record<string, unknown>>;
    readonly version: string;
  },
): Promise<string> {
  const packageSegments = input.name.split("/");
  const storeName = `${input.name.replace("/", "+")}@${input.version}`;
  const packageRoot = join(
    root,
    "node_modules",
    ".pnpm",
    storeName,
    "node_modules",
    ...packageSegments,
  );
  const packageLink = join(root, "node_modules", ...packageSegments);

  await mkdir(packageRoot, { recursive: true });
  await mkdir(join(packageLink, ".."), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify(
      {
        name: input.name,
        version: input.version,
        ...input.packageJson,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  for (const [relativePath, source] of Object.entries(input.files)) {
    const filePath = join(packageRoot, relativePath);
    await mkdir(join(filePath, ".."), { recursive: true });
    await writeFile(filePath, source, "utf8");
  }

  await symlink(packageRoot, packageLink, "junction");
  return packageLink;
}

async function expectFile(path: string): Promise<void> {
  await expect(access(path)).resolves.toBeUndefined();
}
