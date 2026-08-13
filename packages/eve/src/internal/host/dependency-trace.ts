import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { traceNodeModules } from "nf3";
import { FullTracePackages } from "nf3/db";

const DEFAULT_SERVER_TRACE_CONDITIONS = ["node", "import", "default"] as const;

export interface TraceServerDependenciesInput {
  readonly appRoot: string;
  readonly conditions?: readonly string[];
  readonly configuredExternalDependencies: readonly string[];
  readonly outputDirectory: string;
  readonly packageRoot: string;
  readonly sandboxEngineExternalDependencies: readonly string[];
  readonly serverEntryPath: string;
}

export interface TracedServerPackage {
  readonly name: string;
  readonly versions: readonly string[];
}

export interface TraceServerDependenciesResult {
  readonly conditions: readonly string[];
  readonly nodeModulesDirectory: string;
  readonly packageJsonPath: string;
  readonly packages: readonly TracedServerPackage[];
  readonly warnings: readonly string[];
}

interface ExternalDependencySeed {
  readonly packageName: string;
  readonly resolutionNodeModulesDirectory: string;
  readonly specifier: string;
}

/**
 * Traces the runtime package closure of an emitted server into its output
 * directory. Rolldown's external set is the complete package boundary, so
 * synthetic roots trace those packages and their transitive/native closure
 * without making nf3 parse the already self-contained application graph.
 */
export async function traceServerDependencies(
  input: TraceServerDependenciesInput,
): Promise<TraceServerDependenciesResult> {
  const appRoot = resolve(input.appRoot);
  const packageRoot = resolve(input.packageRoot);
  const outputDirectory = resolve(input.outputDirectory);
  const serverEntryPath = resolve(input.serverEntryPath);

  assertServerEntryBelongsToOutput(serverEntryPath, outputDirectory);
  await assertFile(serverEntryPath, "Emitted server entry");

  const conditions = normalizeConditions(input.conditions);
  const externalSpecifiers = normalizeExternalSpecifiers([
    ...input.configuredExternalDependencies,
    ...input.sandboxEngineExternalDependencies,
  ]);
  const seeds = await resolveExternalDependencySeeds(externalSpecifiers, [appRoot, packageRoot]);
  const temporaryRoots: string[] = [];

  try {
    const seedEntries = await writeExternalDependencySeedEntries(seeds, temporaryRoots);
    const warnings: string[] = [];
    let packages: TracedServerPackage[] = [];

    await mkdir(outputDirectory, { recursive: true });
    await traceNodeModules([...seedEntries], {
      conditions: [...conditions],
      fullTraceInclude: [...FullTracePackages],
      outDir: outputDirectory,
      rootDir: appRoot,
      writePackageJson: true,
      hooks: {
        traceResult(result) {
          warnings.push(...[...result.warnings].map(formatTraceWarning));
        },
        tracedPackages(tracedPackages) {
          packages = Object.entries(tracedPackages)
            .map(([name, tracedPackage]) => ({
              name,
              versions: Object.keys(tracedPackage.versions).sort(),
            }))
            .sort((left, right) => left.name.localeCompare(right.name));
        },
      },
    });

    const packageJsonPath = join(outputDirectory, "package.json");
    await assertExplicitDependenciesWereTraced(packageJsonPath, seeds);

    return {
      conditions,
      nodeModulesDirectory: join(outputDirectory, "node_modules"),
      packageJsonPath,
      packages,
      warnings,
    };
  } finally {
    await Promise.all(
      temporaryRoots.map((temporaryRoot) => rm(temporaryRoot, { force: true, recursive: true })),
    );
  }
}

function assertServerEntryBelongsToOutput(serverEntryPath: string, outputDirectory: string): void {
  const relativeEntryPath = relative(outputDirectory, serverEntryPath);

  if (
    relativeEntryPath.length === 0 ||
    relativeEntryPath === ".." ||
    relativeEntryPath.startsWith(`..${sep}`) ||
    isAbsolute(relativeEntryPath)
  ) {
    throw new Error(`Emitted server entry must be inside its output directory: ${serverEntryPath}`);
  }
}

async function assertFile(path: string, description: string): Promise<void> {
  try {
    if ((await stat(path)).isFile()) {
      return;
    }
  } catch {
    // The uniform error below covers missing and non-file entries.
  }

  throw new Error(`${description} does not exist or is not a file: ${path}`);
}

function normalizeConditions(conditions: readonly string[] | undefined): readonly string[] {
  const normalized = [
    ...new Set(
      (conditions ?? DEFAULT_SERVER_TRACE_CONDITIONS).map((condition) => condition.trim()),
    ),
  ].filter((condition) => condition.length > 0);

  if (normalized.length === 0) {
    throw new Error("Server dependency trace requires at least one package condition.");
  }

  return normalized;
}

function normalizeExternalSpecifiers(specifiers: readonly string[]): readonly string[] {
  return [...new Set(specifiers.map((specifier) => specifier.trim()).filter(Boolean))].sort();
}

async function resolveExternalDependencySeeds(
  specifiers: readonly string[],
  resolutionRoots: readonly string[],
): Promise<readonly ExternalDependencySeed[]> {
  const seeds: ExternalDependencySeed[] = [];

  for (const specifier of specifiers) {
    const packageName = parseExternalPackageName(specifier);
    const resolutionNodeModulesDirectory = await findPackageNodeModulesDirectory(
      packageName,
      resolutionRoots,
    );

    if (resolutionNodeModulesDirectory === undefined) {
      throw new Error(
        `Cannot trace external dependency "${specifier}": package "${packageName}" was not found from the app or eve package root.`,
      );
    }

    seeds.push({ packageName, resolutionNodeModulesDirectory, specifier });
  }

  return seeds;
}

function parseExternalPackageName(specifier: string): string {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.includes("\\") ||
    specifier.includes(":") ||
    isBuiltin(specifier)
  ) {
    throw new Error(
      `Invalid external dependency specifier "${specifier}". Expected a package name.`,
    );
  }

  const segments = specifier.split("/");
  const packageName = specifier.startsWith("@")
    ? segments.length >= 2
      ? `${segments[0]}/${segments[1]}`
      : undefined
    : segments[0];

  if (packageName === undefined || packageName.length === 0) {
    throw new Error(
      `Invalid external dependency specifier "${specifier}". Expected a package name.`,
    );
  }

  return packageName;
}

async function findPackageNodeModulesDirectory(
  packageName: string,
  roots: readonly string[],
): Promise<string | undefined> {
  for (const root of roots) {
    let searchDirectory = root;

    while (true) {
      const nodeModulesDirectory = join(searchDirectory, "node_modules");
      const packageJsonPath = join(nodeModulesDirectory, ...packageName.split("/"), "package.json");

      try {
        await access(packageJsonPath);
        return nodeModulesDirectory;
      } catch {
        const parentDirectory = dirname(searchDirectory);
        if (parentDirectory === searchDirectory) {
          break;
        }
        searchDirectory = parentDirectory;
      }
    }
  }

  return undefined;
}

async function writeExternalDependencySeedEntries(
  seeds: readonly ExternalDependencySeed[],
  temporaryRoots: string[],
): Promise<readonly string[]> {
  const specifiersByNodeModulesDirectory = new Map<string, string[]>();

  for (const seed of seeds) {
    const specifiers =
      specifiersByNodeModulesDirectory.get(seed.resolutionNodeModulesDirectory) ?? [];
    specifiers.push(seed.specifier);
    specifiersByNodeModulesDirectory.set(seed.resolutionNodeModulesDirectory, specifiers);
  }

  const seedEntries: string[] = [];
  let index = 0;

  for (const [nodeModulesDirectory, specifiers] of specifiersByNodeModulesDirectory) {
    // pnpm's package links are relative to their real node_modules directory.
    // Keeping the synthetic importer beside that directory prevents tracers
    // from rebasing those links through an unrelated global temporary path.
    const seedRoot = await mkdtemp(
      join(dirname(nodeModulesDirectory), `.eve-dependency-trace-${index}-`),
    );
    const seedEntryPath = join(seedRoot, "entry.mjs");

    temporaryRoots.push(seedRoot);
    await writeFile(
      seedEntryPath,
      `${specifiers.map((specifier) => `import ${JSON.stringify(specifier)};`).join("\n")}\n`,
      "utf8",
    );
    seedEntries.push(seedEntryPath);
    index += 1;
  }

  return seedEntries;
}

async function assertExplicitDependenciesWereTraced(
  packageJsonPath: string,
  seeds: readonly ExternalDependencySeed[],
): Promise<void> {
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as {
    readonly dependencies?: Readonly<Record<string, string>>;
  };
  const tracedDependencies = packageJson.dependencies ?? {};
  const missingPackages = [...new Set(seeds.map((seed) => seed.packageName))].filter(
    (packageName) => tracedDependencies[packageName] === undefined,
  );

  if (missingPackages.length > 0) {
    throw new Error(
      `Failed to trace external dependencies: ${missingPackages.map((name) => JSON.stringify(name)).join(", ")}.`,
    );
  }
}

function formatTraceWarning(warning: Error): string {
  return warning.stack ?? warning.message;
}
