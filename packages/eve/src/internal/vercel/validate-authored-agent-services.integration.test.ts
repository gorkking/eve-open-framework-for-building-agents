import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAgentCollection } from "#internal/agent-collection.js";
import { validateAuthoredAgentServices } from "#internal/vercel/validate-authored-agent-services.js";

async function createCollection(vercelJson: unknown): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "eve-authored-services-"));
  await writeFile(join(root, "package.json"), JSON.stringify({ private: true }));
  await Promise.all([
    mkdir(join(root, "agents", "support", "agent"), { recursive: true }),
    mkdir(join(root, "agents", "research", "agent"), { recursive: true }),
  ]);
  await writeFile(join(root, "vercel.json"), JSON.stringify(vercelJson));
  return root;
}

function supportService() {
  return {
    framework: "eve",
    root: "agents/support",
    routes: [
      {
        src: "^/eve/agents/support/eve/v1/(.*)$",
        transforms: [{ args: "/eve/v1/$1", op: "set", type: "request.path" }],
      },
    ],
  };
}

describe("validateAuthoredAgentServices", () => {
  it("validates selected agents and reports omitted children", async () => {
    const root = await createCollection({
      services: { "customer-care": supportService(), commerce: { root: "apps/commerce" } },
      rewrites: [
        {
          source: "/eve/agents/support/eve/v1/(.*)",
          destination: { service: "customer-care" },
        },
      ],
    });
    const collection = await resolveAgentCollection(root);
    await expect(validateAuthoredAgentServices(collection!)).resolves.toEqual({
      omittedAgentNames: ["research"],
    });
  });

  it("rejects a missing request path transform", async () => {
    const root = await createCollection({
      services: { "customer-care": { ...supportService(), routes: [] } },
      rewrites: [
        {
          source: "/eve/agents/support/eve/v1/(.*)",
          destination: { service: "customer-care" },
        },
      ],
    });
    const collection = await resolveAgentCollection(root);
    await expect(validateAuthoredAgentServices(collection!)).rejects.toThrow(/request.path route/);
  });

  it("rejects a missing public rewrite", async () => {
    const root = await createCollection({ services: { "customer-care": supportService() } });
    const collection = await resolveAgentCollection(root);
    await expect(validateAuthoredAgentServices(collection!)).rejects.toThrow(/must rewrite/);
  });
});
