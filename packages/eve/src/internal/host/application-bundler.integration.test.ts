import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import {
  COMPILE_METADATA_KIND,
  COMPILE_METADATA_VERSION,
  resolveCompilerArtifactPaths,
} from "#compiler/artifacts.js";
import type { CompileAgentResult } from "#compiler/compile-agent.js";
import { createCompiledAgentManifest } from "#compiler/manifest.js";
import { writeCompiledArtifactsFiles } from "#internal/application/compiled-artifacts.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { buildApplicationBundle } from "#internal/host/application-bundler.js";
import { createApplicationRouteRegistryFromInput } from "#internal/host/application-route-registry.js";
import { useTemporaryAppRoots } from "#internal/testing/use-temporary-app-roots.js";
import type { PreparedApplicationHost } from "#internal/host/types.js";

const REMOVED_FRAMEWORK_IMPORT_PATTERN =
  /\b(?:from\s+|import\s*(?:\(\s*)?)["'](?:#nitro(?:\/[^"']*)?|nitro(?:\/[^"']*)?)["']/u;

interface BuiltVercelApplication {
  readonly default: {
    fetch(request: Request): Promise<Response>;
  };
}

const createTemporaryAppRoot = useTemporaryAppRoots();

describe("buildApplicationBundle", () => {
  it("emits a Nitro-free Vercel application that serves home and health", async () => {
    const { agentRoot, appRoot } = await createTemporaryAppRoot("eve-application-bundler-live-", {
      files: {
        "package.json": `${JSON.stringify({ dependencies: { eve: "workspace:*" }, name: "application-bundler-live", type: "module" }, null, 2)}\n`,
      },
      packageName: "application-bundler-live",
    });
    const host = await createPreparedHost({ agentRoot, appRoot });
    const serverDirectory = join(appRoot, ".eve-test", "server");

    const result = await buildApplicationBundle({
      host,
      serverDirectory,
      target: "vercel",
    });

    const emittedModules = (await readdir(serverDirectory, { recursive: true }))
      .filter((path) => path.endsWith(".mjs"))
      .sort();
    expect(emittedModules.length).toBeGreaterThan(0);
    const emittedSources: string[] = [];
    for (const modulePath of emittedModules) {
      const source = await readFile(join(serverDirectory, modulePath), "utf8");
      emittedSources.push(source);
      expect(source, modulePath).not.toMatch(REMOVED_FRAMEWORK_IMPORT_PATTERN);
    }
    const applicationSource = emittedSources.join("\n");
    const expectedStepId = `step//eve@${resolveInstalledPackageInfo().version}//createSessionStep`;
    expect(applicationSource).toContain(".generated/compiled/");
    expect(applicationSource).not.toContain("dist/src/compiled/");
    expect(applicationSource).toContain(expectedStepId);
    expect(result.externalDependencies).toEqual([]);
    expect(emittedModules.some((modulePath) => modulePath.includes("node_modules"))).toBe(false);

    const existingStepRegistry = Reflect.get(
      globalThis,
      Symbol.for("@workflow/core//registeredSteps"),
    ) as Map<string, unknown> | undefined;
    existingStepRegistry?.delete(expectedStepId);
    const application = (await import(
      `${pathToFileURL(result.entryPath).href}?test=${Date.now()}`
    )) as BuiltVercelApplication;
    const stepRegistry = Reflect.get(globalThis, Symbol.for("@workflow/core//registeredSteps")) as
      | Map<string, unknown>
      | undefined;
    expect(stepRegistry?.get(expectedStepId)).toEqual(expect.any(Function));
    const homeResponse = await application.default.fetch(new Request("https://example.com/"));
    const healthResponse = await application.default.fetch(
      new Request("https://example.com/eve/v1/health"),
    );

    expect(homeResponse.status).toBe(200);
    expect(homeResponse.headers.get("content-type")).toContain("text/html");
    expect(await homeResponse.text()).toContain("application-bundler-live");
    expect(healthResponse.status).toBe(200);
    await expect(healthResponse.json()).resolves.toMatchObject({
      ok: true,
      status: "ready",
    });
  });

  it("embeds the strict CrossWS resolver in generated development workers", async () => {
    const { agentRoot, appRoot } = await createTemporaryAppRoot(
      "eve-application-bundler-websocket-",
      { packageName: "application-bundler-websocket" },
    );
    const host = await createPreparedHost({ agentRoot, appRoot });
    const serverDirectory = join(appRoot, ".eve-test", "websocket-server");
    const routeRegistry = createApplicationRouteRegistryFromInput({
      development: true,
      frameworkChannelNames: new Set(),
      frameworkChannels: [],
      manifestChannels: [
        {
          kind: "channel",
          method: "WEBSOCKET",
          name: "socket",
          urlPath: "/socket",
        },
      ],
      scheduleRegistrations: [],
    });

    await buildApplicationBundle({
      host,
      routeRegistry,
      serverDirectory,
      target: "development",
    });

    const emittedModules = (await readdir(serverDirectory, { recursive: true })).filter((path) =>
      path.endsWith(".mjs"),
    );
    const applicationSource = (
      await Promise.all(
        emittedModules.map(
          async (modulePath) => await readFile(join(serverDirectory, modulePath), "utf8"),
        ),
      )
    ).join("\n");

    expect(applicationSource).toContain("No WebSocket route matches this request.");
    expect(applicationSource).toContain("createApplicationWebSocketResolver");
  });
});

async function createPreparedHost(input: {
  readonly agentRoot: string;
  readonly appRoot: string;
}): Promise<PreparedApplicationHost> {
  const manifest = createCompiledAgentManifest({
    agentRoot: input.agentRoot,
    appRoot: input.appRoot,
    config: {
      model: {
        id: "openai/gpt-5.4-mini",
        routing: { kind: "gateway", target: "openai" },
      },
      name: "application-bundler-live",
    },
  });
  const paths = resolveCompilerArtifactPaths(input.appRoot);
  const digest = { path: "fixture", sha256: "0".repeat(64) };
  const compileResult = {
    diagnostics: [],
    manifest,
    metadata: {
      compile: { moduleMap: digest },
      discovery: {
        diagnostics: digest,
        manifest: digest,
        sourceGraphHash: "0".repeat(64),
        summary: { errors: 0, warnings: 0 },
      },
      generator: { name: "eve", version: "0.0.0-test" },
      kind: COMPILE_METADATA_KIND,
      status: "ready",
      version: COMPILE_METADATA_VERSION,
    },
    paths,
    project: {
      agentRoot: input.agentRoot,
      appRoot: input.appRoot,
      layout: "nested",
    },
  } satisfies CompileAgentResult;
  const compiledArtifacts = await writeCompiledArtifactsFiles({
    compileResult,
    defaultWorkflowWorld: "vercel",
    outDir: join(input.appRoot, ".eve-test", "compiled-artifacts"),
  });

  return {
    appRoot: input.appRoot,
    compileResult,
    compiledArtifacts,
    scheduleRegistrations: [],
    schedules: [],
    workflowBuildDir: join(input.appRoot, ".eve-test", "workflow"),
  };
}
