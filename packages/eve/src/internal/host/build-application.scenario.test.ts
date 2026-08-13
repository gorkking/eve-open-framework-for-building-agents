import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCompiledAgentManifest } from "#compiler/manifest.js";
import {
  APPLICATION_BUILD_PROFILE_SCHEMA_VERSION,
  type ApplicationBuildProfile,
} from "#internal/application/build-profile.js";
import type { ApplicationBuildWorkspace } from "#internal/application/build-workspace.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import type {
  ApplicationBundleOptions,
  ApplicationBundleResult,
} from "#internal/host/application-bundler.js";
import type {
  TraceServerDependenciesInput,
  TraceServerDependenciesResult,
} from "#internal/host/dependency-trace.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import type { PreparedApplicationHost } from "#internal/host/types.js";
import {
  VERCEL_EVE_AGENT_SUMMARY_KIND,
  VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH,
  VERCEL_EVE_AGENT_SUMMARY_VERSION,
} from "#internal/vercel-agent-summary.js";

const SCENARIO_EXTERNAL_DEPENDENCY = "scenario-external";

async function buildApplicationBundleFixture(
  options: ApplicationBundleOptions,
): Promise<ApplicationBundleResult> {
  await mkdir(options.serverDirectory, { recursive: true });
  const entryPath = join(options.serverDirectory, "index.mjs");
  await writeFile(entryPath, "export default {}\n");
  await writeFile(
    join(options.serverDirectory, ".vc-config.json"),
    `${JSON.stringify({ memory: 2048, runtime: "nodejs24.x" }, null, 2)}\n`,
  );

  return {
    channelRoutes: options.routeRegistry?.channelRegistrations ?? [],
    entryPath,
    externalDependencies: [SCENARIO_EXTERNAL_DEPENDENCY],
    hasWebSocket: false,
    routePaths: options.routeRegistry?.routePaths ?? [],
    serverDirectory: options.serverDirectory,
  };
}

async function traceServerDependenciesFixture(
  input: TraceServerDependenciesInput,
): Promise<TraceServerDependenciesResult> {
  const packageJsonPath = join(input.outputDirectory, "package.json");
  await writeFile(
    packageJsonPath,
    `${JSON.stringify({ private: true, type: "module" }, null, 2)}\n`,
  );

  return {
    conditions: ["node", "import", "default"],
    nodeModulesDirectory: join(input.outputDirectory, "node_modules"),
    packageJsonPath,
    packages: [],
    warnings: [],
  };
}

const buildApplicationBundleMock = vi.fn(buildApplicationBundleFixture);
const prepareProductionApplicationHostMock = vi.fn();
const resolveDiscoveryProjectMock = vi.fn(async (appRoot: string) => ({
  agentRoot: join(appRoot, "agent"),
  appRoot,
  layout: "nested" as const,
}));
const runVercelBuildPrewarmMock = vi.fn(async () => undefined);
const traceServerDependenciesMock = vi.fn(traceServerDependenciesFixture);
const dependencyTraceModuleLoadMock = vi.fn();

vi.mock("#internal/host/application-bundler.js", () => ({
  buildApplicationBundle: buildApplicationBundleMock,
}));

vi.mock("#internal/host/dependency-trace.js", () => {
  dependencyTraceModuleLoadMock();
  return { traceServerDependencies: traceServerDependenciesMock };
});

vi.mock("./prepare-application-host.js", () => ({
  prepareProductionApplicationHost: prepareProductionApplicationHostMock,
}));

vi.mock("#discover/project.js", () => ({
  resolveDiscoveryProject: resolveDiscoveryProjectMock,
}));

vi.mock("./vercel-build-prewarm.js", () => ({
  runVercelBuildPrewarm: runVercelBuildPrewarmMock,
}));

const createScratchDirectory = useTemporaryDirectories();
const DEPLOYABLE_BUILD_OPTIONS = { skipVercelSandboxPrewarm: false } as const;

function createPreparedHost(appRoot: string): PreparedApplicationHost {
  const agentRoot = join(appRoot, "agent");
  const manifest = createCompiledAgentManifest({
    agentRoot,
    appRoot,
    config: {
      model: { id: "openai/gpt-5.4", routing: { kind: "gateway", target: "openai" } },
      name: "scenario-test-agent",
    },
  });

  return {
    appRoot,
    compileResult: {
      manifest,
      paths: {
        compileDirectoryPath: join(
          appRoot,
          ".eve",
          "builds",
          "test",
          "compiler",
          ".eve",
          "compile",
        ),
      },
      project: {
        agentRoot,
        appRoot,
        layout: "nested",
      },
    } as unknown as PreparedApplicationHost["compileResult"],
    compiledArtifacts: {
      bootstrapPath: join(appRoot, ".eve", "compile", "compiled-artifacts-bootstrap.mjs"),
      workflowWorldPluginPath: join(
        appRoot,
        ".eve",
        "compile",
        "compiled-artifacts-workflow-world.mjs",
      ),
    } as PreparedApplicationHost["compiledArtifacts"],
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: join(appRoot, ".eve", "workflow-cache"),
  };
}

async function prepareHostBuildWorkspace(
  workspace: ApplicationBuildWorkspace,
): Promise<PreparedApplicationHost> {
  const compilerDirectory = join(workspace.compiler.artifactsDir, "compile");
  await mkdir(compilerDirectory, { recursive: true });
  await writeFile(join(compilerDirectory, "compiled-agent-manifest.json"), "{}\n");
  return createPreparedHost(workspace.appRoot);
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function expectServiceVercelOutput(appRoot: string): Promise<void> {
  const outputDirectory = join(appRoot, ".vercel", "output");
  const sharedFunctionDirectory = join(outputDirectory, "functions", "__server.func");
  const healthFunctionDirectory = join(outputDirectory, "functions", "eve", "v1", "health.func");

  expect((await lstat(sharedFunctionDirectory)).isDirectory()).toBe(true);
  expect((await lstat(sharedFunctionDirectory)).isSymbolicLink()).toBe(false);
  expect((await lstat(healthFunctionDirectory)).isSymbolicLink()).toBe(true);
  await expect(realpath(healthFunctionDirectory)).resolves.toBe(
    await realpath(sharedFunctionDirectory),
  );
  await expect(lstat(join(outputDirectory, "functions", "eve", "__server.func"))).rejects.toThrow();
  await expect(lstat(join(outputDirectory, "functions", "index.func"))).rejects.toThrow();

  const config = (await readJson(join(outputDirectory, "config.json"))) as { routes: unknown[] };
  expect(config.routes).toContainEqual({
    dest: "/__server",
    src: "/eve/v1/health",
  });
}

describe("buildApplication", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    buildApplicationBundleMock.mockImplementation(buildApplicationBundleFixture);
    prepareProductionApplicationHostMock.mockImplementation(prepareHostBuildWorkspace);
    traceServerDependenciesMock.mockImplementation(traceServerDependenciesFixture);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds and traces a Node output without publishing stable runtime compiler artifacts", async () => {
    vi.stubEnv("VERCEL", "");
    const appRoot = await createScratchDirectory("eve-build-application-single-");
    const outputDir = join(appRoot, ".output");
    const staleOutputPath = join(outputDir, "stale-output.txt");
    await mkdir(outputDir, { recursive: true });
    await Promise.all([
      writeFile(join(outputDir, "eve-cache.json"), `${JSON.stringify({ eveVersion: "old" })}\n`),
      writeFile(staleOutputPath, "stale\n"),
    ]);

    const { buildApplication } = await import("#internal/host/build-application.js");
    const builtOutputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    expect(builtOutputDir).toBe(outputDir);
    expect(buildApplicationBundleMock).toHaveBeenCalledTimes(1);
    const bundleOptions = buildApplicationBundleMock.mock.calls[0]![0];
    expect(bundleOptions).toMatchObject({
      host: expect.objectContaining({ appRoot }),
      target: "node",
    });
    expect(bundleOptions.serverDirectory).toContain(join(appRoot, ".eve", "builds"));
    expect(dependencyTraceModuleLoadMock).toHaveBeenCalledTimes(1);
    expect(traceServerDependenciesMock).toHaveBeenCalledWith({
      appRoot,
      configuredExternalDependencies: [SCENARIO_EXTERNAL_DEPENDENCY],
      outputDirectory: bundleOptions.serverDirectory,
      packageRoot: expect.any(String),
      sandboxEngineExternalDependencies: [],
      serverEntryPath: join(bundleOptions.serverDirectory, "index.mjs"),
    });
    await expect(readFile(staleOutputPath, "utf8")).rejects.toThrow();
    await expect(readFile(join(outputDir, "server", "index.mjs"), "utf8")).resolves.toContain(
      "export default",
    );
    await expect(readFile(join(outputDir, "server", "package.json"), "utf8")).resolves.toContain(
      '"type": "module"',
    );
    await expect(readFile(join(outputDir, "eve-cache.json"), "utf8")).resolves.toBe(
      `${JSON.stringify(
        {
          eveVersion: resolveInstalledPackageInfo().version,
        },
        null,
        2,
      )}\n`,
    );
    expect(runVercelBuildPrewarmMock).not.toHaveBeenCalled();
    await expect(
      readFile(join(appRoot, ".eve", "compile", "compiled-agent-manifest.json"), "utf8"),
    ).rejects.toThrow();
    await expect(
      readFile(join(outputDir, ".eve", "compile", "compiled-agent-manifest.json"), "utf8"),
    ).resolves.toBe("{}\n");

    const summary = await readJson(join(appRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH));
    expect(summary.kind).toBe(VERCEL_EVE_AGENT_SUMMARY_KIND);
    expect(summary.schemaVersion).toBe(VERCEL_EVE_AGENT_SUMMARY_VERSION);
    expect((summary.agent as { name: string }).name).toBe("scenario-test-agent");
  });

  it("does not load the dependency tracer when the bundle has no externals", async () => {
    vi.stubEnv("VERCEL", "");
    const appRoot = await createScratchDirectory("eve-build-application-no-externals-");
    buildApplicationBundleMock.mockImplementationOnce(async (options) => ({
      ...(await buildApplicationBundleFixture(options)),
      externalDependencies: [],
    }));

    const { buildApplication } = await import("#internal/host/build-application.js");
    await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    expect(dependencyTraceModuleLoadMock).not.toHaveBeenCalled();
    expect(traceServerDependenciesMock).not.toHaveBeenCalled();
  });

  it("writes a versioned timing and output-size profile outside the published output", async () => {
    vi.stubEnv("VERCEL", "");
    const appRoot = await createScratchDirectory("eve-build-application-profile-");
    const profilePath = join(appRoot, ".eve", "profiles", "build.json");

    const { buildApplication } = await import("#internal/host/build-application.js");
    await buildApplication(appRoot, {
      profileOutputPath: profilePath,
      skipVercelSandboxPrewarm: false,
    });

    const profile = JSON.parse(await readFile(profilePath, "utf8")) as ApplicationBuildProfile;

    expect(profile).toMatchObject({
      kind: "eve-build-profile",
      schemaVersion: APPLICATION_BUILD_PROFILE_SCHEMA_VERSION,
      target: "local",
    });
    expect(profile.durationMs).toBeGreaterThanOrEqual(0);
    expect(profile.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "host.prepare" }),
        expect.objectContaining({ name: "host.bundle" }),
        expect.objectContaining({ name: "host.dependencies.trace" }),
        expect.objectContaining({ name: "output.publish" }),
        expect.objectContaining({ name: "workspace.remove" }),
      ]),
    );
    expect(profile.phases.every((phase) => phase.durationMs >= 0)).toBe(true);
    expect(profile.output.files).toBeGreaterThan(0);
    expect(profile.output.rawBytes).toBeGreaterThan(0);
    expect(profile.output.gzipBytes).toBeGreaterThan(0);
    expect(profile.output.functionBundles).toEqual([]);
  });

  it("keeps a profile path inside the published output from failing or changing a build", async () => {
    vi.stubEnv("VERCEL", "");
    const appRoot = await createScratchDirectory("eve-build-application-profile-output-");
    const profilePath = join(appRoot, ".output", "build-profile.json");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const { buildApplication } = await import("#internal/host/build-application.js");
      const outputDir = await buildApplication(appRoot, {
        profileOutputPath: profilePath,
        skipVercelSandboxPrewarm: false,
      });

      expect(outputDir).toBe(join(appRoot, ".output"));
      await expect(readFile(profilePath, "utf8")).rejects.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("must be outside the published output directory"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps profile write errors from failing a completed build", async () => {
    vi.stubEnv("VERCEL", "");
    const appRoot = await createScratchDirectory("eve-build-application-profile-write-error-");
    const profileParentPath = join(appRoot, "profile-parent");
    const profilePath = join(profileParentPath, "build.json");
    await writeFile(profileParentPath, "not-a-directory\n");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const { buildApplication } = await import("#internal/host/build-application.js");
      const outputDir = await buildApplication(appRoot, {
        profileOutputPath: profilePath,
        skipVercelSandboxPrewarm: false,
      });

      expect(outputDir).toBe(join(appRoot, ".output"));
      await expect(readFile(join(outputDir, "eve-cache.json"), "utf8")).resolves.toContain(
        "eveVersion",
      );
      await expect(readFile(profilePath, "utf8")).rejects.toThrow();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("failed to write optional build profile"),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps the last-good output when the direct bundle fails in its scratch workspace", async () => {
    vi.stubEnv("VERCEL", "");
    const appRoot = await createScratchDirectory("eve-build-application-last-good-");
    const outputDir = join(appRoot, ".output");
    const summaryPath = join(appRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH);
    buildApplicationBundleMock.mockImplementationOnce(async (options) => {
      await mkdir(options.serverDirectory, { recursive: true });
      await writeFile(join(options.serverDirectory, "marker.txt"), "partial-failed-output\n");
      throw new Error("injected host bundle failure");
    });
    await Promise.all([
      mkdir(outputDir, { recursive: true }),
      mkdir(join(summaryPath, ".."), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(outputDir, "marker.txt"), "last-good-output\n"),
      writeFile(
        join(outputDir, "eve-cache.json"),
        `${JSON.stringify({ eveVersion: resolveInstalledPackageInfo().version }, null, 2)}\n`,
      ),
      writeFile(summaryPath, "last-good-summary\n"),
    ]);

    const { buildApplication } = await import("#internal/host/build-application.js");
    await expect(buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS)).rejects.toThrow(
      "injected host bundle failure",
    );

    expect(traceServerDependenciesMock).not.toHaveBeenCalled();
    await expect(readFile(join(outputDir, "marker.txt"), "utf8")).resolves.toBe(
      "last-good-output\n",
    );
    await expect(readFile(summaryPath, "utf8")).resolves.toBe("last-good-summary\n");
  });

  it("builds, traces, and emits one service-mode Vercel output", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-");
    const profilePath = join(appRoot, ".eve", "profiles", "vercel-build.json");
    await mkdir(join(appRoot, ".vercel", "output"), { recursive: true });
    await writeFile(
      join(appRoot, ".vercel", "output", "config.json"),
      `${JSON.stringify(
        {
          version: 3,
          experimentalServices: {
            eve: {
              entrypoint: ".",
              framework: "eve",
              mount: "/_eve_internal/eve",
              type: "web",
            },
            web: {
              entrypoint: ".",
              framework: "nextjs",
              mount: "/",
              type: "web",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const { buildApplication } = await import("#internal/host/build-application.js");
    const outputDir = await buildApplication(appRoot, {
      ...DEPLOYABLE_BUILD_OPTIONS,
      profileOutputPath: profilePath,
    });

    expect(outputDir).toBe(join(appRoot, ".vercel", "output"));
    expect(buildApplicationBundleMock).toHaveBeenCalledTimes(1);
    const bundleOptions = buildApplicationBundleMock.mock.calls[0]![0];
    expect(bundleOptions).toMatchObject({
      host: expect.objectContaining({ appRoot }),
      routeRegistry: expect.objectContaining({
        routePaths: expect.arrayContaining(["/", "/eve/v1/health"]),
      }),
      target: "vercel",
    });
    expect(bundleOptions.serverDirectory).toContain(join(appRoot, ".eve", "builds"));
    expect(traceServerDependenciesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot,
        configuredExternalDependencies: [SCENARIO_EXTERNAL_DEPENDENCY],
        outputDirectory: bundleOptions.serverDirectory,
        serverEntryPath: join(bundleOptions.serverDirectory, "index.mjs"),
      }),
    );

    await expectServiceVercelOutput(appRoot);
    const flowFunctionDirectory = join(
      outputDir,
      "functions",
      ".well-known",
      "workflow",
      "v1",
      "flow.func",
    );
    expect((await lstat(flowFunctionDirectory)).isDirectory()).toBe(true);
    expect((await lstat(flowFunctionDirectory)).isSymbolicLink()).toBe(false);
    await expect(readFile(join(flowFunctionDirectory, "index.mjs"), "utf8")).resolves.toContain(
      "export default",
    );
    expect(await readJson(join(flowFunctionDirectory, ".vc-config.json"))).toMatchObject({
      experimentalTriggers: [
        {
          topic: expect.any(String),
          type: "queue/v2beta",
        },
      ],
      maxDuration: "max",
      memory: 2048,
      runtime: "nodejs24.x",
    });
    expect(runVercelBuildPrewarmMock).toHaveBeenCalledWith(
      expect.objectContaining({
        appRoot,
        compiledArtifactsSource: expect.objectContaining({
          kind: "disk",
          sandboxAppRoot: appRoot,
        }),
        log: expect.any(Function),
      }),
    );

    const profile = JSON.parse(await readFile(profilePath, "utf8")) as ApplicationBuildProfile;
    expect(profile.target).toBe("vercel");
    expect(profile.phases).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "sandbox.prewarm" }),
        expect.objectContaining({ name: "host.bundle" }),
        expect.objectContaining({ name: "host.dependencies.trace" }),
        expect.objectContaining({ name: "vercel.output.emit" }),
      ]),
    );
    expect(profile.output.functionBundles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "functions/__server.func" }),
        expect.objectContaining({ path: "functions/.well-known/workflow/v1/flow.func" }),
      ]),
    );

    const summary = await readJson(join(appRoot, VERCEL_EVE_AGENT_SUMMARY_OUTPUT_PATH));
    expect(summary.kind).toBe(VERCEL_EVE_AGENT_SUMMARY_KIND);
    expect(summary.schemaVersion).toBe(VERCEL_EVE_AGENT_SUMMARY_VERSION);
    expect((summary.agent as { name: string }).name).toBe("scenario-test-agent");
  });

  it("skips Vercel sandbox prewarm only when the build opts out", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-skip-prewarm-");

    const { buildApplication } = await import("#internal/host/build-application.js");
    const outputDir = await buildApplication(appRoot, {
      skipVercelSandboxPrewarm: true,
    });

    expect(outputDir).toBe(join(appRoot, ".vercel", "output"));
    expect(runVercelBuildPrewarmMock).not.toHaveBeenCalled();
    expect(buildApplicationBundleMock).toHaveBeenCalledTimes(1);
    expect(buildApplicationBundleMock.mock.calls[0]![0].target).toBe("vercel");
    expect(traceServerDependenciesMock).toHaveBeenCalledTimes(1);
    expect((await lstat(join(outputDir, "functions", "__server.func"))).isDirectory()).toBe(true);
  });

  it("emits service-mode output behind a non-Next host service", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-nuxt-");
    await writeFile(
      join(appRoot, "vercel.json"),
      `${JSON.stringify(
        {
          experimentalServices: {
            eve: {
              entrypoint: ".",
              framework: "eve",
              routePrefix: "/_eve_internal/eve",
            },
            web: {
              entrypoint: ".",
              framework: "nuxtjs",
              routePrefix: "/",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const { buildApplication } = await import("#internal/host/build-application.js");
    await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    await expectServiceVercelOutput(appRoot);
  });

  it("emits service-mode output from a service array", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-service-array-");
    await mkdir(join(appRoot, ".vercel", "output"), { recursive: true });
    await writeFile(
      join(appRoot, ".vercel", "output", "config.json"),
      `${JSON.stringify(
        {
          version: 3,
          services: [
            {
              entrypoint: "package.json",
              framework: "nextjs",
              name: "web",
              root: ".",
            },
            {
              entrypoint: "package.json",
              framework: "eve",
              name: "eve-support",
              root: ".",
              routePrefix: "/eve/agents/support",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const { buildApplication } = await import("#internal/host/build-application.js");
    await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    await expectServiceVercelOutput(appRoot);
  });

  it("resolves service roots relative to a linked Vercel root directory", async () => {
    vi.stubEnv("VERCEL", "1");
    const projectRoot = await createScratchDirectory("eve-build-application-vercel-root-dir-");
    const appRoot = join(projectRoot, "apps", "web", "agents", "support");
    await mkdir(join(projectRoot, ".vercel", "output"), { recursive: true });
    await writeFile(
      join(projectRoot, ".vercel", "project.json"),
      `${JSON.stringify(
        {
          settings: {
            rootDirectory: "apps/web",
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile(join(projectRoot, ".vercel", "output", "builds.json"), "{}\n");
    await writeFile(
      join(projectRoot, ".vercel", "output", "config.json"),
      `${JSON.stringify(
        {
          experimentalServicesV2: {
            web: {
              framework: "nextjs",
              root: ".",
            },
            "eve-support": {
              framework: "eve",
              root: "agents/support",
              routePrefix: "/eve/agents/support",
            },
          },
          version: 3,
        },
        null,
        2,
      )}\n`,
    );

    const { buildApplication } = await import("#internal/host/build-application.js");
    await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    await expectServiceVercelOutput(appRoot);
  });

  it("emits service-mode output from legacy root service config", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-root-config-");
    await writeFile(
      join(appRoot, "vercel.json"),
      `${JSON.stringify(
        {
          experimentalServices: {
            eve: {
              entrypoint: ".",
              framework: "eve",
              routePrefix: "/_eve_internal/eve",
            },
            web: {
              entrypoint: ".",
              framework: "nextjs",
              routePrefix: "/",
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const { buildApplication } = await import("#internal/host/build-application.js");
    const outputDir = await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    expect(outputDir).toBe(join(appRoot, ".vercel", "output"));
    await expectServiceVercelOutput(appRoot);
  });

  it("leaves standalone Vercel output routable at the root", async () => {
    vi.stubEnv("VERCEL", "1");
    const appRoot = await createScratchDirectory("eve-build-application-vercel-standalone-");

    const { buildApplication } = await import("#internal/host/build-application.js");
    await buildApplication(appRoot, DEPLOYABLE_BUILD_OPTIONS);

    const outputDirectory = join(appRoot, ".vercel", "output");
    const rootFunctionDirectory = join(outputDirectory, "functions", "index.func");
    const sharedFunctionDirectory = join(outputDirectory, "functions", "__server.func");

    expect((await lstat(rootFunctionDirectory)).isSymbolicLink()).toBe(true);
    expect((await lstat(sharedFunctionDirectory)).isDirectory()).toBe(true);
    await expect(realpath(rootFunctionDirectory)).resolves.toBe(
      await realpath(sharedFunctionDirectory),
    );
    await expect(readFile(join(rootFunctionDirectory, "index.mjs"), "utf8")).resolves.toContain(
      "export default",
    );
  });
});
