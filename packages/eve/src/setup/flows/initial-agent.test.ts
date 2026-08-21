import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";

import { runInitialAgentSetupFlow } from "./initial-agent.js";

const APP_ROOT = "/tmp/agent";

describe("runInitialAgentSetupFlow", () => {
  it("preserves item setup facts in the installation result", async () => {
    const answers = ["channel/web", "next", "next", "install"];
    const fake = createFakePrompter({ single: () => answers.shift()! });
    const installRegistryItem = vi.fn(async () => ({
      output: [],
      setup: {
        facts: [{ label: "Agent URL", value: "https://agent.example.com", kind: "url" as const }],
      },
    }));

    await expect(
      runInitialAgentSetupFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        deps: {
          browseRegistryCatalog: vi.fn(async () => ({
            items: [
              {
                address: "channel/web",
                name: "channel/web",
                title: "Web Chat",
                source: "Vercel",
              },
              {
                address: "experimental/self-modification",
                name: "experimental/self-modification",
                title: "Self-modification (Experimental)",
                source: "Vercel",
              },
            ],
            total: 1,
            errors: [],
          })),
          installRegistryItem,
          detectDeployment: vi.fn(async () => ({ state: "unlinked" as const })),
          runDeployFlow: vi.fn(async () => ({ kind: "deployed" as const })),
        },
      }),
    ).resolves.toEqual({
      kind: "done",
      result: {
        kind: "done",
        addedItems: ["channel/web"],
        items: [
          {
            address: "channel/web",
            title: "Web Chat",
            facts: [{ label: "Agent URL", value: "https://agent.example.com", kind: "url" }],
            output: [],
          },
        ],
        facts: [{ label: "Agent URL", value: "https://agent.example.com", kind: "url" }],
        failures: [],
        output: [],
      },
    });
    expect(installRegistryItem).toHaveBeenCalledWith(
      APP_ROOT,
      "channel/web",
      expect.objectContaining({ silent: true, prompter: fake.prompter }),
    );
  });

  it("retains a skipped installation error for the closing report", async () => {
    const answers = ["channel/web", "next", "next", "install", "skip"];
    const fake = createFakePrompter({ single: () => answers.shift()! });

    await expect(
      runInitialAgentSetupFlow({
        appRoot: APP_ROOT,
        prompter: fake.prompter,
        deps: {
          browseRegistryCatalog: vi.fn(async () => ({
            items: [
              { address: "channel/web", name: "channel/web", title: "Web Chat", source: "Vercel" },
            ],
            total: 1,
            errors: [],
          })),
          installRegistryItem: vi.fn(async () => {
            throw new Error("Missing WEB_TOKEN\nMore detail");
          }),
          detectDeployment: vi.fn(async () => ({ state: "unlinked" as const })),
          runDeployFlow: vi.fn(async () => ({ kind: "deployed" as const })),
        },
      }),
    ).resolves.toMatchObject({
      kind: "done",
      result: {
        addedItems: [],
        failures: [
          expect.objectContaining({
            address: "channel/web",
            title: "Web Chat",
            message: "Missing WEB_TOKEN",
            detail: expect.stringContaining("Missing WEB_TOKEN\nMore detail"),
          }),
        ],
      },
    });
  });
});
