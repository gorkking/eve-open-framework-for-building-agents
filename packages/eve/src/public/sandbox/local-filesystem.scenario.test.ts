import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { useTemporaryDirectories } from "#internal/testing/use-temporary-app-roots.js";
import { LocalFilesystemSandbox } from "#public/sandbox/local-filesystem.js";
import { restoreSandbox, serializeSandbox } from "#shared/sandbox-value.js";

const createScratchDirectory = useTemporaryDirectories();

describe("LocalFilesystemSandbox", () => {
  it("maps the sandbox workspace onto a durable host directory", async () => {
    const root = await createScratchDirectory("eve-local-filesystem-sandbox-");
    const sandbox = await LocalFilesystemSandbox.open({ root });

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
});
