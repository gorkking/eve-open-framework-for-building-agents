import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveAgentCollection,
  resolveOwningAgentCollection,
} from "#internal/agent-collection.js";

async function createCollection(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-collection-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
  await Promise.all([
    mkdir(join(root, "agents", "support", "agent"), { recursive: true }),
    mkdir(join(root, "agents", "research", "agent"), { recursive: true }),
  ]);
  return root;
}

describe("resolveAgentCollection", () => {
  it("discovers strict direct children in deterministic order", async () => {
    const root = await createCollection();
    await expect(resolveAgentCollection(root)).resolves.toMatchObject({
      mode: "inferred",
      members: [
        { name: "research", appRoot: join(root, "agents", "research") },
        { name: "support", appRoot: join(root, "agents", "support") },
      ],
      root,
    });
  });

  it("recognizes an authored Vercel service graph", async () => {
    const root = await createCollection();
    await writeFile(join(root, "vercel.json"), JSON.stringify({ services: {} }));
    await expect(resolveAgentCollection(root)).resolves.toMatchObject({ mode: "authored" });
  });

  it("rejects root-agent coexistence", async () => {
    const root = await createCollection();
    await mkdir(join(root, "agent"));
    await expect(resolveAgentCollection(root)).rejects.toThrow(/both root agent\/ and agents\//);
  });

  it("rejects flat children", async () => {
    const root = await mkdtemp(join(tmpdir(), "eve-collection-flat-"));
    await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
    await mkdir(join(root, "agents", "support"), { recursive: true });
    await writeFile(join(root, "agents", "support", "agent.ts"), "export default {};\n");
    await expect(resolveAgentCollection(root)).rejects.toThrow(/Move flat authored files/);
  });

  it("resolves the collection that owns a package-less child", async () => {
    const root = await createCollection();
    await expect(
      resolveOwningAgentCollection(join(root, "agents", "support")),
    ).resolves.toMatchObject({
      collection: { root },
      member: { name: "support" },
    });
  });
});
