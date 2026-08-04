import { describe, expect, it, vi } from "vitest";

import { createFakePrompter } from "#internal/testing/fake-prompter.js";
import {
  connectResendMarketplaceResource,
  listResendMarketplaceResources,
  listVercelDomains,
  provisionResendMarketplaceResource,
  type ResendMarketplaceDeps,
} from "./marketplace.js";

function capture(stdout: unknown): ResendMarketplaceDeps["captureVercel"] {
  return vi.fn<ResendMarketplaceDeps["captureVercel"]>(async () => ({
    ok: true,
    stdout: JSON.stringify(stdout),
  }));
}

describe("Resend Marketplace", () => {
  it("lists only Resend Marketplace resources", async () => {
    const captureVercel = capture({
      stores: [
        {
          id: "store_resend",
          externalResourceId: "example.com",
          name: "resend-agent",
          product: { slug: "resend-email", integrationConfigurationId: "icfg_resend" },
        },
        {
          id: "store_other",
          externalResourceId: "db-1",
          name: "database",
          product: { slug: "postgres" },
        },
      ],
    });

    await expect(
      listResendMarketplaceResources({
        projectRoot: "/project",
        project: { orgId: "team", projectId: "project" },
        deps: { captureVercel },
      }),
    ).resolves.toEqual([
      expect.objectContaining({ id: "store_resend", externalResourceId: "example.com" }),
    ]);
  });

  it("lists Vercel-owned domains", async () => {
    const captureVercel = capture({
      domains: [{ name: "example.com" }, { name: "another.example" }],
    });

    await expect(
      listVercelDomains({
        projectRoot: "/project",
        project: { orgId: "team", projectId: "project" },
        deps: { captureVercel },
      }),
    ).resolves.toEqual(["example.com", "another.example"]);
  });

  it("provisions Resend with domain metadata and production connection", async () => {
    const runVercelCaptureStdout = vi.fn(async () => ({
      ok: true,
      stdout: JSON.stringify({
        resource: {
          id: "store_resend",
          name: "resend-agent",
          externalResourceId: "example.com",
        },
        installation: { id: "icfg_resend" },
      }),
    }));

    await provisionResendMarketplaceResource({
      domain: "example.com",
      log: createFakePrompter().prompter.log,
      projectRoot: "/project",
      project: { orgId: "team", projectId: "project" },
      deps: { runVercelCaptureStdout },
    });

    expect(runVercelCaptureStdout).toHaveBeenCalledWith(
      [
        "integration",
        "add",
        "resend",
        "--metadata",
        "domain=example.com",
        "--metadata",
        "region=us-east-1",
        "--environment",
        "production",
        "--json",
        "--scope",
        "team",
      ],
      expect.objectContaining({ cwd: "/project" }),
    );
  });

  it("does not reconnect a resource already attached to the linked project", async () => {
    const runVercelCaptureStdout = vi.fn();
    await connectResendMarketplaceResource({
      resource: {
        id: "store_resend",
        externalResourceId: "example.com",
        name: "resend-agent",
        projectsMetadata: [{ projectId: "project", environments: ["production"] }],
      },
      log: createFakePrompter().prompter.log,
      projectRoot: "/project",
      project: { orgId: "team", projectId: "project" },
      deps: { runVercelCaptureStdout },
    });
    expect(runVercelCaptureStdout).not.toHaveBeenCalled();
  });
});
