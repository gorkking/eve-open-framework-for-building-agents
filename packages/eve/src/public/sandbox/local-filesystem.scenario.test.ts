import { mkdir, readFile, rm } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { LocalFilesystemSandbox } from "#public/sandbox/local-filesystem.js";
import {
  restoreSandbox,
  serializeSandbox,
  withSandboxProviderContext,
} from "#shared/sandbox-value.js";

const createScratchDirectory = useTemporaryDirectories();

describe("LocalFilesystemSandbox", () => {
  it("maps the sandbox workspace onto a durable host directory", async () => {
    const root = await createScratchDirectory("eve-local-filesystem-sandbox-");
    const sandbox = await openLocalFilesystemSandbox(root);

    expect(sandbox.resolvePath("README.md")).toBe("/workspace/README.md");
    await sandbox.writeTextFile({
      content: "hello from eve\n",
      path: "README.md",
    });
    expect(await readFile(`${root}/README.md`, "utf8")).toBe("hello from eve\n");

    const command = await sandbox.run({
      command: "printf 'generated' > generated.txt",
    });
    expect(command.exitCode).toBe(0);

    const restored = restoreSandbox(await serializeSandbox(sandbox));
    await expect(restored.readTextFile({ path: "generated.txt" })).resolves.toBe("generated");
  });

  it("does not accept a replacement directory at a persisted path", async () => {
    const root = await createScratchDirectory("eve-local-filesystem-sandbox-replaced-");
    const sandbox = await openLocalFilesystemSandbox(root);
    const serialized = await serializeSandbox(sandbox);
    await rm(root, { recursive: true });
    await mkdir(root);

    const restored = restoreSandbox(serialized);

    await expect(restored.readTextFile({ path: "missing.txt" })).rejects.toThrow(
      `Persisted sandbox "${root}" is unavailable from provider "local-filesystem"`,
    );
  });

  it("resolves relative roots from the eve application root", async () => {
    const appRoot = await createScratchDirectory("eve-local-filesystem-app-");
    const sandbox = await openLocalFilesystemSandbox("workspace", appRoot);

    await sandbox.writeTextFile({ content: "scoped\n", path: "scope.txt" });

    await expect(readFile(`${appRoot}/workspace/scope.txt`, "utf8")).resolves.toBe("scoped\n");
  });
});

async function openLocalFilesystemSandbox(root: string, appRoot = root) {
  return await withSandboxProviderContext(
    {
      appRoot,
      resourceId: "local-filesystem-test",
      signal: new AbortController().signal,
    },
    async () => await LocalFilesystemSandbox.open({ root }),
  );
}
