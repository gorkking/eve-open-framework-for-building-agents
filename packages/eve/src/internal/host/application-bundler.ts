import { readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { stringifyEsmImportSpecifier } from "#internal/application/import-specifier.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import {
  resolvePackageRoot,
  resolvePackageSourceFilePath,
  resolveWorkflowModulePath,
} from "#internal/application/package.js";
import { buildWithRolldown } from "#internal/bundler/rolldown.js";
import { createExtensionScopePlugin } from "#internal/bundler/extension-scope-plugin.js";
import { createApplicationBundleWarningFilter } from "#internal/bundler/warning-log.js";
import { createNodeEsmCompatBannerPlugin } from "#internal/node-esm-compat-banner.js";
import {
  createDevelopmentApplicationArtifactsConfig,
  createProductionApplicationArtifactsConfig,
} from "#internal/host/artifacts-config.js";
import { createCompiledSandboxBackendPrunePlugin } from "#internal/host/compiled-sandbox-backend-prune-plugin.js";
import {
  createOptionalEngineDependencyPlugin,
  OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME,
} from "#internal/host/optional-engine-dependency-plugin.js";
import type { PreparedApplicationHost } from "#internal/host/types.js";
import type { ApplicationArtifactsConfig } from "#internal/host/routes/runtime-artifacts.js";
import { WorkflowBundleBuilder } from "#internal/workflow-bundle/builder.js";
import { createDynamicCapabilityTransformPlugin } from "#internal/workflow-bundle/dynamic-capability-transform-plugin.js";
import { EVE_WORKFLOW_FLOW_ROUTE_PATH } from "#protocol/routes.js";
import {
  applyWorkflowTransform,
  detectWorkflowPatterns,
} from "#internal/workflow-bundle/workflow-builders.js";
import { deriveEveWorkflowQueuePrefix } from "#internal/workflow/queue-namespace.js";
import { usesParentDevelopmentWorkflowWorld } from "#internal/workflow/development-world-protocol.js";
import {
  createApplicationRouteRegistry,
  type ApplicationChannelRouteRegistration,
  type ApplicationRouteRegistry,
} from "#internal/host/application-route-registry.js";

const APPLICATION_ENTRY_ID = "\0eve-application-entry";
const WORKFLOW_MODULE_SPECIFIERS = new Set([
  "workflow",
  "workflow/api",
  "workflow/errors",
  "workflow/internal/builtins",
  "workflow/internal/private",
  "workflow/runtime",
]);
const LOCAL_SANDBOX_BACKEND_NAMES = new Set([
  "docker",
  ...Object.keys(OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME),
]);

export type ApplicationBundleTarget = "development" | "node" | "vercel";

export interface ApplicationBundleOptions {
  readonly cronRoute?: string;
  readonly host: PreparedApplicationHost;
  readonly routeRegistry?: ApplicationRouteRegistry;
  readonly serverDirectory: string;
  readonly target: ApplicationBundleTarget;
}

export interface ApplicationBundleResult {
  readonly channelRoutes: readonly ApplicationChannelRouteRegistration[];
  readonly entryPath: string;
  readonly externalDependencies: readonly string[];
  readonly hasWebSocket: boolean;
  readonly routePaths: readonly string[];
  readonly serverDirectory: string;
}

interface ApplicationBundleConfiguration {
  readonly configuredExternalDependencies: readonly string[];
  readonly plugins: readonly object[];
  readonly tracedExternalDependencies: readonly string[];
}

/**
 * Builds one complete eve host graph with Rolldown. The generated entry owns
 * startup, routing, platform adaptation, and lifecycle; no framework build
 * layer runs before or after this pass.
 */
export async function buildApplicationBundle(
  options: ApplicationBundleOptions,
): Promise<ApplicationBundleResult> {
  const { host, target } = options;
  const packageRoot = resolvePackageRoot();
  const packageConditionNames = resolveApplicationBundleConditionNames(packageRoot);
  const workflowBuilder = new WorkflowBundleBuilder({
    agentName: host.compileResult.manifest.config.name,
    appRoot: host.appRoot,
    compiledArtifactsBootstrapPath: host.compiledArtifacts.bootstrapPath,
    outDir: host.workflowBuildDir,
    rootDir: packageRoot,
  });
  await workflowBuilder.build();

  const stepEntrypointPath = join(host.workflowBuildDir, "steps.mjs");
  const stepTransformTargets = await collectStepTransformTargets(stepEntrypointPath);
  const routeRegistry =
    options.routeRegistry ??
    createApplicationRouteRegistry(host, {
      development: target === "development",
      vercelCron: false,
    });
  const channelRoutes = routeRegistry.channelRegistrations;
  const hasWebSocket = channelRoutes.some((route) => route.method === "WEBSOCKET");
  const artifacts =
    target === "development"
      ? createDevelopmentApplicationArtifactsConfig({
          appRoot: host.appRoot,
          configuredWorld: host.compileResult.manifest.config.experimental?.workflow?.world,
        })
      : createProductionApplicationArtifactsConfig();
  const bundler = createApplicationBundleConfiguration(host, target);
  const source = createApplicationEntrySource({
    artifacts,
    channelRoutes,
    cronRoute: options.cronRoute,
    hasWebSocket,
    host,
    target,
    workflowBundlePath: join(host.workflowBuildDir, "workflows.mjs"),
    workflowStepsPath: stepEntrypointPath,
  });
  const warningFilter = createApplicationBundleWarningFilter();

  await rm(options.serverDirectory, { force: true, recursive: true });
  await buildWithRolldown({
    cwd: packageRoot,
    input: APPLICATION_ENTRY_ID,
    onLog: warningFilter.onLog,
    platform: "node",
    external: (sourceId: string) =>
      bundler.configuredExternalDependencies.some((packageName) =>
        isPackageImport(sourceId, packageName),
      ),
    plugins: [
      createApplicationEntryPlugin(source),
      createWorkflowModuleAliasPlugin(),
      createWorkflowStepTransformPlugin({
        projectRoot: host.appRoot,
        targets: stepTransformTargets,
      }),
      createDynamicCapabilityTransformPlugin(),
      ...bundler.plugins,
      createNodeEsmCompatBannerPlugin({ includeRequire: true }),
    ],
    resolve: {
      conditionNames: packageConditionNames,
      extensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
      mainFields: ["module", "main"],
    },
    treeshake: true,
    output: {
      chunkFileNames: "_chunks/[name]-[hash].mjs",
      codeSplitting: true,
      comments: false,
      dir: options.serverDirectory,
      entryFileNames: "index.mjs",
      format: "esm",
      minify: false,
      sourcemap: false,
    },
  });

  const routePaths = [
    ...routeRegistry.routePaths,
    ...(options.cronRoute === undefined ? [] : [options.cronRoute]),
  ];

  return {
    channelRoutes,
    entryPath: join(options.serverDirectory, "index.mjs"),
    externalDependencies: bundler.tracedExternalDependencies,
    hasWebSocket,
    routePaths: [...new Set(routePaths)],
    serverDirectory: options.serverDirectory,
  };
}

export function resolveApplicationBundleConditionNames(
  packageRoot: string,
  packageModulePath: string = resolvePackageSourceFilePath(
    "src/internal/host/application-bundler.ts",
  ),
): readonly string[] {
  const relativeModulePath = normalizeModulePath(relative(packageRoot, packageModulePath));

  // Rolldown supplies `node`/`default` and chooses `import` or `require` per
  // edge. Listing either import kind here would force it onto every edge.
  return relativeModulePath.startsWith("src/") ? ["eve-source"] : [];
}

function createWorkflowModuleAliasPlugin(): object {
  return {
    name: "eve-workflow-module-alias",
    resolveId(source: string) {
      return WORKFLOW_MODULE_SPECIFIERS.has(source) ? resolveWorkflowModulePath(source) : undefined;
    },
  };
}

function createApplicationEntryPlugin(source: string): object {
  return {
    name: "eve-application-entry",
    resolveId(id: string) {
      return id === APPLICATION_ENTRY_ID ? { id } : undefined;
    },
    load(id: string) {
      return id === APPLICATION_ENTRY_ID
        ? { code: source, moduleSideEffects: true, moduleType: "js" as const }
        : undefined;
    },
  };
}

function createWorkflowStepTransformPlugin(input: {
  readonly projectRoot: string;
  readonly targets: ReadonlySet<string>;
}): object {
  return {
    name: "eve-workflow-step-transform",
    resolveId(source: string) {
      const normalized = normalizeModulePath(source);
      return input.targets.has(normalized)
        ? { id: normalized, moduleSideEffects: "no-treeshake" as const }
        : undefined;
    },
    async transform(code: string, id: string) {
      const normalized = normalizeModulePath(id);
      if (!input.targets.has(normalized)) {
        return null;
      }
      const patterns = detectWorkflowPatterns(code);
      if (!patterns.hasUseStep && !patterns.hasSerde) {
        return null;
      }
      const filename = createRelativeTransformFilename(input.projectRoot, normalized);
      const result = await applyWorkflowTransform(
        filename,
        code,
        "step",
        normalized,
        input.projectRoot,
      );
      return { code: result.code, map: null };
    },
  };
}

async function collectStepTransformTargets(stepEntrypointPath: string): Promise<Set<string>> {
  const source = await readFile(stepEntrypointPath, "utf8");
  const targets = new Set<string>();
  const pattern = /^\s*import\s+(?:.+?\s+from\s+)?["']([^"']+)["'];?\s*$/gm;
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1];
    if (specifier === undefined) {
      continue;
    }
    if (specifier.startsWith("file://")) {
      targets.add(normalizeModulePath(fileURLToPath(specifier)));
    } else if (isAbsolute(specifier)) {
      targets.add(normalizeModulePath(specifier));
    } else if (specifier.startsWith(".")) {
      targets.add(normalizeModulePath(resolve(dirname(stepEntrypointPath), specifier)));
    }
  }
  return targets;
}

function normalizeModulePath(path: string): string {
  const withoutSuffix = path.split(/[?#]/u, 1)[0] ?? path;
  const normalized = withoutSuffix.replaceAll("\\", "/");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function createRelativeTransformFilename(projectRoot: string, modulePath: string): string {
  const packageRelativePath = createPackageRelativeTransformFilename(modulePath);
  if (packageRelativePath !== undefined) {
    return packageRelativePath;
  }

  const path = relative(projectRoot, modulePath).replaceAll("\\", "/");
  if (path !== "" && !path.startsWith("../") && !path.includes(":")) {
    return path;
  }
  return modulePath.split("/").pop() ?? "unknown.ts";
}

function createPackageRelativeTransformFilename(modulePath: string): string | undefined {
  const packageRoot = resolvePackageRoot().replaceAll("\\", "/").replace(/\/$/u, "");
  const normalizedPath = modulePath.replaceAll("\\", "/");
  const lowerPackageRoot = packageRoot.toLowerCase();
  const lowerPath = normalizedPath.toLowerCase();
  const sourcePrefix = `${packageRoot}/src/`;
  const distSourcePrefix = `${packageRoot}/dist/src/`;

  if (lowerPath.startsWith(`${lowerPackageRoot}/src/`)) {
    return `src/${normalizedPath.slice(sourcePrefix.length)}`;
  }
  if (lowerPath.startsWith(`${lowerPackageRoot}/dist/src/`)) {
    return `src/${normalizedPath.slice(distSourcePrefix.length)}`;
  }
  return undefined;
}

function createApplicationBundleConfiguration(
  host: PreparedApplicationHost,
  target: ApplicationBundleTarget,
): ApplicationBundleConfiguration {
  const manifest = host.compileResult.manifest;
  const nodes = [manifest, ...manifest.subagents.map((subagent) => subagent.agent)];
  const configuredBackendNames = new Set(
    nodes
      .map((node) => node.sandbox?.backendName)
      .filter((name): name is string => name !== undefined),
  );
  const configuredOptionalEnginePackages: string[] = [];
  const unconfiguredOptionalEnginePackages: string[] = [];
  for (const [backendName, packageName] of Object.entries(
    OPTIONAL_ENGINE_PACKAGES_BY_BACKEND_NAME,
  )) {
    (configuredBackendNames.has(backendName)
      ? configuredOptionalEnginePackages
      : unconfiguredOptionalEnginePackages
    ).push(packageName);
  }
  const authoredExternalDependencies = [
    ...(manifest.config.build?.externalDependencies ?? []),
    ...manifest.subagents.flatMap((subagent) =>
      subagent.configResolver === undefined
        ? (subagent.agent.config.build?.externalDependencies ?? [])
        : (subagent.configResolver.build?.externalDependencies ?? []),
    ),
  ];
  const tracedExternalDependencies = [
    ...new Set([...configuredOptionalEnginePackages, ...authoredExternalDependencies]),
  ].filter((dependency) => dependency !== "eve");
  const extensionScopePlugin = createExtensionScopePlugin(
    nodes.flatMap((node) =>
      node.extensionMounts.map((mount) => ({
        packageNamespace: mount.packageNamespace,
        sourceRoot: mount.sourceRoot,
      })),
    ),
  );
  const shouldPruneLocalBackends =
    target === "vercel" &&
    ![...configuredBackendNames].some((name) => LOCAL_SANDBOX_BACKEND_NAMES.has(name));
  const plugins = [
    shouldPruneLocalBackends ? createCompiledSandboxBackendPrunePlugin() : null,
    createOptionalEngineDependencyPlugin(unconfiguredOptionalEnginePackages),
    extensionScopePlugin,
  ].flatMap((plugin) => (plugin === null ? [] : [plugin]));

  return {
    configuredExternalDependencies: [
      ...tracedExternalDependencies,
      ...unconfiguredOptionalEnginePackages,
    ],
    plugins,
    tracedExternalDependencies,
  };
}

function isPackageImport(source: string, packageName: string): boolean {
  return source === packageName || source.startsWith(`${packageName}/`);
}

function manifestEnablesWorkflow(manifest: CompiledAgentManifest): boolean {
  return [manifest, ...manifest.subagents.map((subagent) => subagent.agent)].some(
    (node) => node.workflowTool !== undefined,
  );
}

function createApplicationEntrySource(input: {
  readonly artifacts: ApplicationArtifactsConfig;
  readonly channelRoutes: readonly ApplicationChannelRouteRegistration[];
  readonly cronRoute?: string;
  readonly hasWebSocket: boolean;
  readonly host: PreparedApplicationHost;
  readonly target: ApplicationBundleTarget;
  readonly workflowBundlePath: string;
  readonly workflowStepsPath: string;
}): string {
  const { host, target } = input;
  const imports: string[] = ["// Generated by eve. Do not edit by hand."];
  const pluginBindings: string[] = [];
  const addPlugin = (binding: string, path: string): void => {
    imports.push(`import ${binding} from ${stringifyEsmImportSpecifier(path)};`);
    pluginBindings.push(binding);
  };

  if (target === "development" && host.compiledArtifacts.instrumentationPluginPath === undefined) {
    addPlugin(
      "installLocalTracingRuntime",
      resolvePackageSourceFilePath("src/internal/host/local-tracing-runtime-plugin.ts"),
    );
  }
  addPlugin("installCompiledArtifacts", host.compiledArtifacts.bootstrapPath);
  addPlugin("installWorkflowWorld", host.compiledArtifacts.workflowWorldPluginPath);
  if (manifestEnablesWorkflow(host.compileResult.manifest)) {
    addPlugin(
      "installWorkflowSandboxRuntime",
      resolvePackageSourceFilePath("src/internal/host/workflow-sandbox-runtime-plugin.ts"),
    );
  }
  if (host.compiledArtifacts.instrumentationPluginPath !== undefined) {
    addPlugin("installInstrumentation", host.compiledArtifacts.instrumentationPluginPath);
  }
  if (target === "node") {
    addPlugin(
      "installSandboxShutdown",
      resolvePackageSourceFilePath("src/internal/host/sandbox-shutdown-plugin.ts"),
    );
  }

  imports.push(
    `import { ApplicationLifecycle } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/internal/host/application-lifecycle.ts"))};`,
    `import { createApplicationRouter } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/internal/host/application-router.ts"))};`,
    `import { POST as workflowPOST } from ${stringifyEsmImportSpecifier(input.workflowBundlePath)};`,
    `import { __steps_registered as workflowStepsRegistered } from ${stringifyEsmImportSpecifier(input.workflowStepsPath)};`,
  );

  if (target === "development" && shouldRegisterDirectWorkflowHandler(host, target)) {
    imports.push(
      `import { getWorld as getWorkflowWorld } from ${stringifyEsmImportSpecifier(resolveWorkflowModulePath("workflow/runtime"))};`,
    );
  } else if (target === "node" && shouldRegisterDirectWorkflowHandler(host, target)) {
    imports.push(
      `import { getWorld as getWorkflowWorld } from ${stringifyEsmImportSpecifier(resolveWorkflowModulePath("workflow/runtime"))};`,
    );
  }

  if (input.cronRoute !== undefined) {
    imports.push(
      `import { createVercelCronHandler } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/internal/host/vercel-cron-handler.ts"))};`,
    );
  }

  if (target === "node") {
    imports.push(
      `import { startNodeApplication } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/internal/host/node-application.ts"))};`,
    );
  } else if (target === "vercel") {
    imports.push(
      `import { createVercelApplicationHandler } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/internal/host/vercel-application.ts"))};`,
    );
  } else {
    imports.push(
      `import { ApplicationTaskTracker, createTrackedApplicationFetch } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/internal/host/application-task-tracker.ts"))};`,
    );
    if (input.hasWebSocket) {
      imports.push(
        `import { createApplicationWebSocketResolver } from ${stringifyEsmImportSpecifier(resolvePackageSourceFilePath("src/internal/host/application-websocket.ts"))};`,
      );
    }
  }

  const artifacts = JSON.stringify(input.artifacts);
  const scheduleRegistrations = JSON.stringify(host.scheduleRegistrations);
  const lines = [
    ...imports,
    "",
    "const lifecycle = new ApplicationLifecycle();",
    "void workflowStepsRegistered;",
    ...pluginBindings.map((binding) => `${binding}(lifecycle);`),
  ];

  if (shouldRegisterDirectWorkflowHandler(host, target)) {
    lines.push(
      "const workflowWorld = await getWorkflowWorld();",
      'if (typeof workflowWorld?.registerHandler === "function") {',
      `  workflowWorld.registerHandler(${JSON.stringify(deriveEveWorkflowQueuePrefix(host.compileResult.manifest.config.name))}, workflowPOST);`,
      "}",
    );
  }

  if (input.cronRoute !== undefined) {
    lines.push(
      `const cronHandler = createVercelCronHandler({ artifactsConfig: ${artifacts}, scheduleRegistrations: ${scheduleRegistrations} });`,
    );
  }

  lines.push(
    "const app = createApplicationRouter({",
    `  agentName: ${JSON.stringify(host.compileResult.manifest.config.name)},`,
    `  artifacts: ${artifacts},`,
    `  channels: ${JSON.stringify(input.channelRoutes)},`,
  );
  if (target === "development") {
    lines.push(`  development: { artifacts: ${artifacts} },`);
  }
  if (input.cronRoute !== undefined) {
    lines.push(`  cron: { handler: cronHandler, route: ${JSON.stringify(input.cronRoute)} },`);
  }
  lines.push(
    `  workflow: { handler: workflowPOST, route: ${JSON.stringify(EVE_WORKFLOW_FLOW_ROUTE_PATH)} },`,
    "});",
    "",
  );

  if (target === "development") {
    lines.push(
      "const taskTracker = new ApplicationTaskTracker();",
      "const applicationFetch = createTrackedApplicationFetch(app.fetch, taskTracker);",
      "const worker = {",
      "  fetch: applicationFetch,",
      "  ipc: { onClose: async () => { await taskTracker.close(); await lifecycle.close(); } },",
    );
    if (input.hasWebSocket) {
      lines.push("  websocket: { resolve: createApplicationWebSocketResolver(applicationFetch) },");
    }
    lines.push("};", "export default worker;");
  } else if (target === "node") {
    lines.push(
      "const server = await startNodeApplication({",
      "  fetch: app.fetch,",
      "  lifecycle,",
      ...(input.hasWebSocket ? ["  websocket: true,"] : []),
      ...(host.scheduleRegistrations.length === 0
        ? []
        : [
            `  scheduleRuntimeOptions: { artifactsConfig: ${artifacts}, scheduleRegistrations: ${scheduleRegistrations} },`,
          ]),
      "});",
      "export default server;",
    );
  } else {
    lines.push(
      "const handler = createVercelApplicationHandler({",
      "  fetch: app.fetch,",
      ...(input.hasWebSocket ? ["  websocket: true,"] : []),
      "});",
      "export default handler;",
    );
  }

  return `${lines.join("\n")}\n`;
}

function shouldRegisterDirectWorkflowHandler(
  host: PreparedApplicationHost,
  target: ApplicationBundleTarget,
): boolean {
  const configuredWorld = host.compileResult.manifest.config.experimental?.workflow?.world;
  if (target === "development") {
    return !usesParentDevelopmentWorkflowWorld(configuredWorld);
  }
  return target === "node" && configuredWorld !== undefined;
}
