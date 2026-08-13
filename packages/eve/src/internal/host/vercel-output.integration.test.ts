import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { emitVercelBuildOutput } from "#internal/host/vercel-output.js";
import { createEveWorkflowQueueTrigger } from "#internal/workflow/queue-namespace.js";
import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";

const createScratchDirectory = useTemporaryDirectories();

async function readJson(path: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function createServerFunctionDirectory(root: string): Promise<string> {
  const serverFunctionDirectory = join(root, "built-server-function");
  await mkdir(join(serverFunctionDirectory, "chunks"), { recursive: true });
  await writeFile(
    join(serverFunctionDirectory, "index.mjs"),
    'export { value } from "./chunks/value.mjs";\n',
  );
  await writeFile(
    join(serverFunctionDirectory, "chunks", "value.mjs"),
    "export const value = 1;\n",
  );
  await writeFile(
    join(serverFunctionDirectory, ".vc-config.json"),
    `${JSON.stringify(
      {
        environment: { BASE: "server" },
        handler: "index.mjs",
        memory: 2048,
        runtime: "nodejs24.x",
      },
      null,
      2,
    )}\n`,
  );
  return serverFunctionDirectory;
}

describe("emitVercelBuildOutput", () => {
  it("emits a standalone shared function, route aliases, and isolated workflow copy", async () => {
    const root = await createScratchDirectory("eve-vercel-output-standalone-");
    const serverFunctionDirectory = await createServerFunctionDirectory(root);
    const outputDirectory = join(root, "output");
    await mkdir(join(outputDirectory, "functions", "stale.func"), { recursive: true });
    await writeFile(join(outputDirectory, "keep.txt"), "preserved\n");

    const result = await emitVercelBuildOutput({
      crons: [{ path: "/eve/v1/cron/token", schedule: "0 8 * * *" }],
      framework: { slug: "eve", version: "9.8.7" },
      outputDirectory,
      routes: [
        { path: "/" },
        { path: "/eve/v1/health" },
        { path: "/eve/v1/session/:sessionId/stream" },
      ],
      serverFunctionDirectory,
      workflow: {
        agentName: "weather-agent",
        environment: { FLOW_ONLY: "1" },
        publicRoutePrefix: "/eve/agents/weather/",
      },
    });

    expect(await readFile(join(outputDirectory, "keep.txt"), "utf8")).toBe("preserved\n");
    await expect(lstat(join(outputDirectory, "functions", "stale.func"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await lstat(result.sharedServerFunctionDirectory)).isDirectory()).toBe(true);
    expect((await lstat(result.sharedServerFunctionDirectory)).isSymbolicLink()).toBe(false);
    expect((await lstat(result.workflowFunctionDirectory)).isDirectory()).toBe(true);
    expect((await lstat(result.workflowFunctionDirectory)).isSymbolicLink()).toBe(false);

    const healthFunction = join(outputDirectory, "functions", "eve", "v1", "health.func");
    const streamFunction = join(
      outputDirectory,
      "functions",
      "eve",
      "v1",
      "session",
      "[sessionId]",
      "stream.func",
    );
    const indexFunction = join(outputDirectory, "functions", "index.func");
    for (const functionPath of [healthFunction, streamFunction, indexFunction]) {
      expect((await lstat(functionPath)).isSymbolicLink()).toBe(true);
      await expect(realpath(functionPath)).resolves.toBe(
        await realpath(result.sharedServerFunctionDirectory),
      );
    }
    await expect(readFile(join(streamFunction, "chunks", "value.mjs"), "utf8")).resolves.toBe(
      "export const value = 1;\n",
    );

    expect(await readJson(result.configPath)).toEqual({
      version: 3,
      framework: { slug: "eve", version: "9.8.7" },
      routes: [
        { handle: "filesystem" },
        {
          src: "/\\.well-known/workflow/v1/flow",
          dest: "/.well-known/workflow/v1/flow",
        },
        { src: "/eve/v1/health", dest: "/eve/v1/health" },
        { src: "/", dest: "/index" },
        {
          src: "/eve/v1/session/(?<sessionId>[^/]+)/stream",
          dest: "/eve/v1/session/[sessionId]/stream",
        },
        { src: "/(.*)", dest: "/__server" },
      ],
      crons: [{ path: "/eve/v1/cron/token", schedule: "0 8 * * *" }],
    });
    expect(await readJson(join(result.sharedServerFunctionDirectory, ".vc-config.json"))).toEqual({
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      runtime: "nodejs24.x",
      memory: 2048,
      environment: { BASE: "server" },
    });
    expect(await readJson(join(result.workflowFunctionDirectory, ".vc-config.json"))).toEqual({
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      runtime: "nodejs24.x",
      memory: 2048,
      maxDuration: "max",
      experimentalTriggers: [createEveWorkflowQueueTrigger("weather-agent")],
      environment: {
        BASE: "server",
        FLOW_ONLY: "1",
        EVE_PUBLIC_ROUTE_PREFIX: "/eve/agents/weather",
        WORKFLOW_PRECONDITION_GUARD: "1",
      },
    });
  });

  it("emits service-owned functions and prefixes only eve cron routes", async () => {
    const root = await createScratchDirectory("eve-vercel-output-service-");
    const serverFunctionDirectory = join(root, "built-server-function");
    const outputDirectory = join(root, "output");
    await mkdir(serverFunctionDirectory, { recursive: true });
    await writeFile(join(serverFunctionDirectory, "index.mjs"), "export default {};\n");

    const result = await emitVercelBuildOutput({
      crons: [
        { path: "/eve/v1/cron/token", schedule: "*/5 * * * *" },
        { path: "/api/host-cron", schedule: "0 0 * * *" },
      ],
      framework: { slug: "eve", version: "1.0.0" },
      mode: "service",
      outputDirectory,
      routes: [
        { path: "/" },
        { path: "/custom" },
        { path: "/eve/v1/health" },
        { path: "/eve/v1/session/:sessionId" },
      ],
      serverFunctionDirectory,
      workflow: {
        agentName: "support",
        publicRoutePrefix: "/eve/agents/support",
      },
    });

    expect(result.sharedServerFunctionPath).toBe("__server.func");
    expect(await readJson(result.configPath)).toEqual({
      version: 3,
      framework: { slug: "eve", version: "1.0.0" },
      routes: [
        { handle: "filesystem" },
        {
          src: "/\\.well-known/workflow/v1/flow",
          dest: "/.well-known/workflow/v1/flow",
        },
        { src: "/eve/v1/health", dest: "/__server" },
        { src: "/eve/v1/session/(?<sessionId>[^/]+)", dest: "/__server" },
      ],
      crons: [
        {
          path: "/eve/agents/support/eve/v1/cron/token",
          schedule: "*/5 * * * *",
        },
        { path: "/api/host-cron", schedule: "0 0 * * *" },
      ],
    });
    expect((await lstat(join(outputDirectory, "functions", "__server.func"))).isDirectory()).toBe(
      true,
    );
    await expect(
      lstat(join(outputDirectory, "functions", "eve", "__server.func")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(outputDirectory, "functions", "index.func"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(lstat(join(outputDirectory, "functions", "custom.func"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const healthFunction = join(outputDirectory, "functions", "eve", "v1", "health.func");
    expect((await lstat(healthFunction)).isSymbolicLink()).toBe(true);
    await expect(realpath(healthFunction)).resolves.toBe(
      await realpath(result.sharedServerFunctionDirectory),
    );
    expect(await readJson(join(result.sharedServerFunctionDirectory, ".vc-config.json"))).toEqual({
      handler: "index.mjs",
      launcherType: "Nodejs",
      shouldAddHelpers: false,
      supportsResponseStreaming: true,
      runtime: "nodejs24.x",
    });
  });

  it("rejects overlapping source/output trees and missing handlers", async () => {
    const root = await createScratchDirectory("eve-vercel-output-invalid-");
    const outputDirectory = join(root, "output");
    const nestedServerFunctionDirectory = join(outputDirectory, "server");
    await mkdir(nestedServerFunctionDirectory, { recursive: true });
    await writeFile(join(nestedServerFunctionDirectory, "index.mjs"), "export default {};\n");

    await expect(
      emitVercelBuildOutput({
        framework: { slug: "eve", version: "1.0.0" },
        outputDirectory,
        routes: [],
        serverFunctionDirectory: nestedServerFunctionDirectory,
        workflow: { agentName: "invalid" },
      }),
    ).rejects.toThrow("must not overlap");

    const missingHandlerDirectory = join(root, "missing-handler");
    await mkdir(missingHandlerDirectory, { recursive: true });
    await expect(
      emitVercelBuildOutput({
        framework: { slug: "eve", version: "1.0.0" },
        outputDirectory,
        routes: [],
        serverFunctionDirectory: missingHandlerDirectory,
        workflow: { agentName: "invalid" },
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
