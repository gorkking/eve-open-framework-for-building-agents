import { access, cp, lstat, mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { EVE_PACKAGE_NAME } from "#internal/package-name.js";
import { createEveWorkflowQueueTrigger } from "#internal/workflow/queue-namespace.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#protocol/routes.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import { atomicWriteFile } from "#shared/atomic-write-file.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";
import { renameWithTransientBusyRetry } from "#shared/rename-with-retry.js";

export const VERCEL_BUILD_OUTPUT_VERSION = 3 as const;
export const VERCEL_SERVER_FUNCTION_PATH = "__server.func";
export const VERCEL_WORKFLOW_FUNCTION_PATH = `${EVE_WORKFLOW_FLOW_ROUTE_PATH.slice(1)}.func`;

const VERCEL_FUNCTION_CONFIG_FILE_NAME = ".vc-config.json";
const VERCEL_OUTPUT_CONFIG_FILE_NAME = "config.json";
const VERCEL_SERVER_ROUTE_DESTINATION = "/__server";
const EVE_CRON_ROUTE_PREFIX = `${EVE_ROUTE_PREFIX}/cron/`;
const ROUTE_PARAMETER_PATTERN = /^:[A-Za-z_$][\w$]*$/u;

const DEFAULT_SERVER_FUNCTION_CONFIG: Readonly<Record<string, unknown>> = {
  handler: "index.mjs",
  launcherType: "Nodejs",
  shouldAddHelpers: false,
  supportsResponseStreaming: true,
  runtime: "nodejs24.x",
};

export type VercelOutputMode = "service" | "standalone";

/**
 * The filesystem router's build-time projection. HTTP methods are deliberately
 * absent: Vercel sends every method for a URL to the same server function and
 * H3 remains responsible for method dispatch inside that function.
 *
 * Paths may contain static segments and H3-style `:parameter` segments. Other
 * matcher syntax is rejected because emitting an approximate Vercel regex can
 * make a route reachable at a URL the runtime router would not accept.
 */
export interface VercelRouteRegistryEntry {
  readonly path: string;
}

export interface VercelCronEntry {
  readonly path: string;
  readonly schedule: string;
}

export interface VercelWorkflowOutputOptions {
  readonly agentName: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly publicRoutePrefix?: string;
}

export interface VercelFrameworkMetadata {
  readonly slug: string;
  readonly version: string;
}

export interface CreateVercelBuildOutputPlanInput {
  readonly crons?: readonly VercelCronEntry[];
  readonly framework: VercelFrameworkMetadata;
  readonly mode?: VercelOutputMode;
  readonly publicRoutePrefix?: string;
  readonly routes: readonly VercelRouteRegistryEntry[];
}

export interface EmitVercelBuildOutputInput {
  /**
   * Directory owned by this emitter. `config.json` and `functions/` are
   * replaced; unrelated top-level entries are preserved. Callers publish this
   * directory only after the emitter succeeds.
   */
  readonly outputDirectory: string;
  /**
   * Self-contained server-function payload produced by Rolldown and external
   * tracing. It must live outside `outputDirectory`; relative symlinks are
   * copied verbatim and therefore must resolve within the copied payload.
   */
  readonly serverFunctionDirectory: string;
  readonly routes: readonly VercelRouteRegistryEntry[];
  readonly workflow: VercelWorkflowOutputOptions;
  readonly crons?: readonly VercelCronEntry[];
  readonly framework?: VercelFrameworkMetadata;
  readonly mode?: VercelOutputMode;
}

export interface VercelBuildOutputFunctionRoute {
  readonly dest: string;
  readonly src: string;
}

export interface VercelBuildOutputFilesystemRoute {
  readonly handle: "filesystem";
}

export type VercelBuildOutputRoute =
  | VercelBuildOutputFilesystemRoute
  | VercelBuildOutputFunctionRoute;

export interface VercelBuildOutputConfig extends Record<string, unknown> {
  readonly version: typeof VERCEL_BUILD_OUTPUT_VERSION;
  readonly framework: VercelFrameworkMetadata;
  readonly routes: readonly VercelBuildOutputRoute[];
  readonly crons?: readonly VercelCronEntry[];
}

export interface VercelFunctionAliasPlan {
  /** POSIX path relative to the Build Output `functions/` directory. */
  readonly functionPath: string;
  readonly routePath: string;
}

export interface VercelBuildOutputPlan {
  readonly config: VercelBuildOutputConfig;
  readonly routeAliases: readonly VercelFunctionAliasPlan[];
  /** POSIX path relative to the Build Output `functions/` directory. */
  readonly sharedServerFunctionPath: string;
  /** POSIX path relative to the Build Output `functions/` directory. */
  readonly workflowFunctionPath: string;
}

export interface EmittedVercelBuildOutput extends VercelBuildOutputPlan {
  readonly configPath: string;
  readonly functionsDirectory: string;
  readonly sharedServerFunctionDirectory: string;
  readonly workflowFunctionDirectory: string;
}

interface NormalizedRoute {
  readonly destination: string;
  readonly functionPath: string;
  readonly index: number;
  readonly parameterSegments: readonly boolean[];
  readonly path: string;
  readonly source: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeOutputPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function assertNonEmptyString(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
}

function parseRouteSegments(path: string): readonly string[] {
  if (!path.startsWith("/")) {
    throw new Error(`Vercel route path must start with "/": ${JSON.stringify(path)}.`);
  }
  if (path === "/") {
    return [];
  }
  if (path.endsWith("/")) {
    throw new Error(`Vercel route path must not end with "/": ${JSON.stringify(path)}.`);
  }
  if (path.includes("\\") || path.includes("\0") || path.includes("?") || path.includes("#")) {
    throw new Error(`Vercel route path contains unsupported characters: ${JSON.stringify(path)}.`);
  }

  const segments = path.slice(1).split("/");
  const parameterNames = new Set<string>();

  for (const segment of segments) {
    if (segment.length === 0 || segment === "." || segment === "..") {
      throw new Error(`Vercel route path contains an invalid segment: ${JSON.stringify(path)}.`);
    }

    if (segment.startsWith(":")) {
      if (!ROUTE_PARAMETER_PATTERN.test(segment)) {
        throw new Error(
          `Vercel route parameter must be a JavaScript identifier: ${JSON.stringify(segment)} in ${JSON.stringify(path)}.`,
        );
      }

      const name = segment.slice(1);
      if (parameterNames.has(name)) {
        throw new Error(
          `Vercel route parameter ${JSON.stringify(name)} appears more than once in ${JSON.stringify(path)}.`,
        );
      }
      parameterNames.add(name);
      continue;
    }

    if (
      segment.includes(":") ||
      segment.includes("*") ||
      segment.includes("[") ||
      segment.includes("]")
    ) {
      throw new Error(
        `Vercel route path contains unsupported matcher syntax: ${JSON.stringify(path)}.`,
      );
    }
  }

  return segments;
}

function normalizeRoute(entry: VercelRouteRegistryEntry, index: number): NormalizedRoute {
  const segments = parseRouteSegments(entry.path);
  const parameterSegments = segments.map((segment) => segment.startsWith(":"));
  const sourceSegments = segments.map((segment) => {
    if (!segment.startsWith(":")) {
      return escapeRegularExpression(segment);
    }

    const name = segment.slice(1);
    return `(?<${name}>[^/]+)`;
  });
  const destinationSegments = segments.map((segment) =>
    segment.startsWith(":") ? `[${segment.slice(1)}]` : segment,
  );
  const destination =
    destinationSegments.length === 0 ? "/index" : `/${destinationSegments.join("/")}`;

  return {
    destination,
    functionPath: `${destination.slice(1)}.func`,
    index,
    parameterSegments,
    path: entry.path,
    source: sourceSegments.length === 0 ? "/" : `/${sourceSegments.join("/")}`,
  };
}

function compareRouteSpecificity(left: NormalizedRoute, right: NormalizedRoute): number {
  const parameterCountDelta =
    left.parameterSegments.filter(Boolean).length - right.parameterSegments.filter(Boolean).length;
  if (parameterCountDelta !== 0) {
    return parameterCountDelta;
  }

  const comparedSegments = Math.min(left.parameterSegments.length, right.parameterSegments.length);

  for (let index = 0; index < comparedSegments; index += 1) {
    const leftIsParameter = left.parameterSegments[index];
    const rightIsParameter = right.parameterSegments[index];
    if (leftIsParameter !== rightIsParameter) {
      return leftIsParameter ? 1 : -1;
    }
  }

  if (left.parameterSegments.length !== right.parameterSegments.length) {
    return right.parameterSegments.length - left.parameterSegments.length;
  }

  return left.index - right.index;
}

function normalizeRoutes(
  routes: readonly VercelRouteRegistryEntry[],
  mode: VercelOutputMode,
): readonly NormalizedRoute[] {
  const uniquePaths = new Set<string>();
  const normalized: NormalizedRoute[] = [];

  for (const [index, route] of routes.entries()) {
    const nextRoute = normalizeRoute(route, index);
    if (uniquePaths.has(nextRoute.path)) {
      continue;
    }
    uniquePaths.add(nextRoute.path);

    if (nextRoute.path === EVE_WORKFLOW_FLOW_ROUTE_PATH) {
      continue;
    }
    if (
      mode === "service" &&
      nextRoute.path !== EVE_ROUTE_PREFIX &&
      !nextRoute.path.startsWith(`${EVE_ROUTE_PREFIX}/`)
    ) {
      continue;
    }

    normalized.push(nextRoute);
  }

  return normalized.sort(compareRouteSpecificity);
}

function normalizeCrons(
  crons: readonly VercelCronEntry[],
  mode: VercelOutputMode,
  publicRoutePrefix: string | undefined,
): readonly VercelCronEntry[] {
  const normalizedPrefix = normalizePublicRoutePrefix(publicRoutePrefix);
  const keys = new Set<string>();
  const normalized: VercelCronEntry[] = [];

  for (const cron of crons) {
    parseRouteSegments(cron.path);
    assertNonEmptyString(cron.schedule, "Vercel cron schedule");

    const path =
      mode === "service" &&
      normalizedPrefix !== undefined &&
      cron.path.startsWith(EVE_CRON_ROUTE_PREFIX)
        ? `${normalizedPrefix}${cron.path}`
        : cron.path;
    const nextCron = {
      path,
      schedule: cron.schedule,
    };
    const key = `${nextCron.path}\0${nextCron.schedule}`;
    if (!keys.has(key)) {
      keys.add(key);
      normalized.push(nextCron);
    }
  }

  return normalized;
}

/**
 * Creates the complete filesystem/config plan without touching disk. Service
 * output intentionally keeps only `/eve/v1/**` routes, matching the existing
 * generated-service contract where the host owns `/` and proxies eve's
 * protocol surface. Workflow retains its dedicated function in both modes.
 */
export function createVercelBuildOutputPlan(
  input: CreateVercelBuildOutputPlanInput,
): VercelBuildOutputPlan {
  assertNonEmptyString(input.framework.slug, "Vercel framework slug");
  assertNonEmptyString(input.framework.version, "Vercel framework version");

  const mode = input.mode ?? "standalone";
  const routes = normalizeRoutes(input.routes, mode);
  const sharedServerFunctionPath = VERCEL_SERVER_FUNCTION_PATH;
  const sharedServerDestination = VERCEL_SERVER_ROUTE_DESTINATION;
  const outputRoutes: VercelBuildOutputRoute[] = [
    { handle: "filesystem" },
    {
      src: escapeRegularExpression(EVE_WORKFLOW_FLOW_ROUTE_PATH),
      dest: EVE_WORKFLOW_FLOW_ROUTE_PATH,
    },
    ...routes.map((route) => ({
      src: route.source,
      dest: mode === "service" ? sharedServerDestination : route.destination,
    })),
  ];

  if (mode === "standalone") {
    outputRoutes.push({
      src: "/(.*)",
      dest: sharedServerDestination,
    });
  }

  const crons = normalizeCrons(input.crons ?? [], mode, input.publicRoutePrefix);
  const configWithoutCrons: VercelBuildOutputConfig = {
    version: VERCEL_BUILD_OUTPUT_VERSION,
    framework: input.framework,
    routes: outputRoutes,
  };
  const config: VercelBuildOutputConfig =
    crons.length === 0 ? configWithoutCrons : { ...configWithoutCrons, crons };

  return {
    config,
    routeAliases: routes
      .filter((route) => route.functionPath !== sharedServerFunctionPath)
      .map((route) => ({
        functionPath: route.functionPath,
        routePath: route.path,
      })),
    sharedServerFunctionPath,
    workflowFunctionPath: VERCEL_WORKFLOW_FUNCTION_PATH,
  };
}

function readFunctionEnvironment(
  config: Readonly<Record<string, unknown>>,
): Readonly<Record<string, string>> {
  const environment = config.environment;
  if (environment === undefined) {
    return {};
  }
  if (!isRecord(environment)) {
    throw new Error("Vercel function environment must contain a JSON object.");
  }

  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string") {
      throw new Error(
        `Vercel function environment variable ${JSON.stringify(name)} must contain a string.`,
      );
    }
  }

  return environment as Record<string, string>;
}

/** Builds the route-specific config for the queue-triggered workflow copy. */
export function createVercelWorkflowFunctionConfig(input: {
  readonly baseConfig: Readonly<Record<string, unknown>>;
  readonly workflow: VercelWorkflowOutputOptions;
}): Readonly<Record<string, unknown>> {
  assertNonEmptyString(input.workflow.agentName, "Workflow agent name");

  const publicRoutePrefix = normalizePublicRoutePrefix(input.workflow.publicRoutePrefix);
  const environment: Record<string, string> = {
    ...readFunctionEnvironment(input.baseConfig),
    ...input.workflow.environment,
    WORKFLOW_PRECONDITION_GUARD: "1",
  };
  if (publicRoutePrefix !== undefined) {
    environment[EVE_PUBLIC_ROUTE_PREFIX_ENV] = publicRoutePrefix;
  }

  return {
    ...input.baseConfig,
    maxDuration: "max",
    experimentalTriggers: [createEveWorkflowQueueTrigger(input.workflow.agentName)],
    environment,
  };
}

async function readServerFunctionConfig(
  serverFunctionDirectory: string,
): Promise<Readonly<Record<string, unknown>>> {
  const configPath = join(serverFunctionDirectory, VERCEL_FUNCTION_CONFIG_FILE_NAME);
  let sourceConfig: Record<string, unknown> = {};

  try {
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      throw new Error(`Vercel function config at ${JSON.stringify(configPath)} must be an object.`);
    }
    sourceConfig = parsed;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  const config = {
    ...DEFAULT_SERVER_FUNCTION_CONFIG,
    ...sourceConfig,
  };
  const handler = config.handler;
  if (typeof handler !== "string" || handler.trim().length === 0) {
    throw new Error("Vercel server function config must name a handler.");
  }
  if (
    handler.startsWith("/") ||
    handler.includes("\\") ||
    handler.includes("\0") ||
    handler.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(`Vercel server function handler is not a safe relative path: ${handler}.`);
  }

  await access(join(serverFunctionDirectory, ...handler.split("/")));
  readFunctionEnvironment(config);
  return config;
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}${sep}`) || right.startsWith(`${left}${sep}`);
}

async function assertServerFunctionDirectory(
  serverFunctionDirectory: string,
  outputDirectory: string,
): Promise<void> {
  if (pathsOverlap(serverFunctionDirectory, outputDirectory)) {
    throw new Error(
      "The built server function directory and Vercel output directory must not overlap.",
    );
  }

  const stats = await lstat(serverFunctionDirectory);
  if (!stats.isDirectory()) {
    throw new Error(
      `Built server function path is not a directory: ${JSON.stringify(serverFunctionDirectory)}.`,
    );
  }
}

async function createFunctionAlias(
  functionsDirectory: string,
  alias: VercelFunctionAliasPlan,
  sharedServerFunctionDirectory: string,
): Promise<void> {
  const functionPath = join(functionsDirectory, ...alias.functionPath.split("/"));
  await mkdir(dirname(functionPath), { recursive: true });
  await symlink(
    normalizeOutputPath(relative(dirname(functionPath), sharedServerFunctionDirectory)),
    functionPath,
    "dir",
  );
}

/**
 * Emits one Vercel Build Output API v3 tree from an already-built function.
 * The function payload is copied once as the shared server, route functions
 * are relative symlinks, and workflow is a physical copy so its queue trigger,
 * environment, and maximum duration remain isolated in `.vc-config.json`.
 *
 * This function does not discover services, copy host middleware, or publish
 * the finished directory. A framework integration supplies `mode: "service"`
 * and its public prefix, then performs host assembly after this succeeds.
 */
export async function emitVercelBuildOutput(
  input: EmitVercelBuildOutputInput,
): Promise<EmittedVercelBuildOutput> {
  const outputDirectory = resolve(input.outputDirectory);
  const serverFunctionDirectory = resolve(input.serverFunctionDirectory);
  await assertServerFunctionDirectory(serverFunctionDirectory, outputDirectory);

  const framework = input.framework ?? {
    slug: EVE_PACKAGE_NAME,
    version: resolveInstalledPackageInfo().version,
  };
  const plan = createVercelBuildOutputPlan({
    crons: input.crons,
    framework,
    mode: input.mode,
    publicRoutePrefix: input.workflow.publicRoutePrefix,
    routes: input.routes,
  });
  const baseFunctionConfig = await readServerFunctionConfig(serverFunctionDirectory);
  const workflowFunctionConfig = createVercelWorkflowFunctionConfig({
    baseConfig: baseFunctionConfig,
    workflow: input.workflow,
  });

  await mkdir(outputDirectory, { recursive: true });
  const stagingRoot = await mkdtemp(join(outputDirectory, ".eve-vercel-functions-"));
  const stagingFunctionsDirectory = join(stagingRoot, "functions");
  const sharedServerFunctionDirectory = join(
    stagingFunctionsDirectory,
    ...plan.sharedServerFunctionPath.split("/"),
  );
  const workflowFunctionDirectory = join(
    stagingFunctionsDirectory,
    ...plan.workflowFunctionPath.split("/"),
  );

  try {
    await mkdir(dirname(sharedServerFunctionDirectory), { recursive: true });
    await cp(serverFunctionDirectory, sharedServerFunctionDirectory, {
      recursive: true,
      verbatimSymlinks: true,
    });
    await atomicWriteFile(
      join(sharedServerFunctionDirectory, VERCEL_FUNCTION_CONFIG_FILE_NAME),
      `${JSON.stringify(baseFunctionConfig, null, 2)}\n`,
    );

    await mkdir(dirname(workflowFunctionDirectory), { recursive: true });
    await cp(sharedServerFunctionDirectory, workflowFunctionDirectory, {
      recursive: true,
      verbatimSymlinks: true,
    });
    await atomicWriteFile(
      join(workflowFunctionDirectory, VERCEL_FUNCTION_CONFIG_FILE_NAME),
      `${JSON.stringify(workflowFunctionConfig, null, 2)}\n`,
    );

    await Promise.all(
      plan.routeAliases.map((alias) =>
        createFunctionAlias(stagingFunctionsDirectory, alias, sharedServerFunctionDirectory),
      ),
    );

    const functionsDirectory = join(outputDirectory, "functions");
    await rm(functionsDirectory, { force: true, recursive: true });
    await renameWithTransientBusyRetry(stagingFunctionsDirectory, functionsDirectory);
    await atomicWriteFile(
      join(outputDirectory, VERCEL_OUTPUT_CONFIG_FILE_NAME),
      `${JSON.stringify(plan.config, null, 2)}\n`,
    );

    return {
      ...plan,
      configPath: join(outputDirectory, VERCEL_OUTPUT_CONFIG_FILE_NAME),
      functionsDirectory,
      sharedServerFunctionDirectory: join(
        functionsDirectory,
        ...plan.sharedServerFunctionPath.split("/"),
      ),
      workflowFunctionDirectory: join(functionsDirectory, ...plan.workflowFunctionPath.split("/")),
    };
  } finally {
    await rm(stagingRoot, { force: true, recursive: true });
  }
}
