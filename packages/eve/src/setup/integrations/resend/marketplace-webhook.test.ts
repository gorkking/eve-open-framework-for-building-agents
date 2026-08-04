import { describe, expect, it, vi } from "vitest";

import {
  deleteMarketplaceResendWebhooks,
  reconcileMarketplaceResendWebhook,
  type MarketplaceWebhookDeps,
} from "./marketplace-webhook.js";

const RESULT_PREFIX = "EVE_RESEND_RESULT=";

function result(value: unknown): string {
  return `${RESULT_PREFIX}${Buffer.from(JSON.stringify(value), "utf8").toString("base64url")}\n`;
}

describe("Resend Marketplace webhook helper", () => {
  it("runs reconciliation with production Marketplace environment variables", async () => {
    const runVercelCaptureStdout = vi.fn<MarketplaceWebhookDeps["runVercelCaptureStdout"]>(
      async () => ({
        ok: true,
        stdout: result({ id: "wh_new", signingSecret: "whsec_new", previousIds: ["wh_old"] }),
      }),
    );

    await expect(
      reconcileMarketplaceResendWebhook({
        endpoint: "https://agent.test/eve/v1/resend",
        projectRoot: "/project",
        orgId: "team",
        deps: { runVercelCaptureStdout },
      }),
    ).resolves.toEqual({
      id: "wh_new",
      signingSecret: "whsec_new",
      previousIds: ["wh_old"],
    });

    const [args, options] = runVercelCaptureStdout.mock.calls[0]!;
    expect(args.slice(0, 7)).toEqual([
      "env",
      "run",
      "--environment",
      "production",
      "--scope",
      "team",
      "--",
    ]);
    expect(args).toContain("reconcile");
    expect(args).toContain("https://agent.test/eve/v1/resend");
    expect(args.join(" ")).not.toContain("whsec_new");
    expect(options).toMatchObject({ cwd: "/project", nonInteractive: true });
  });

  it("runs deletion without exposing credentials", async () => {
    const runVercelCaptureStdout = vi.fn<MarketplaceWebhookDeps["runVercelCaptureStdout"]>(
      async () => ({
        ok: true,
        stdout: result({ deleted: ["wh_old"] }),
      }),
    );
    await deleteMarketplaceResendWebhooks({
      ids: ["wh_old"],
      projectRoot: "/project",
      orgId: "team",
      deps: { runVercelCaptureStdout } satisfies MarketplaceWebhookDeps,
    });
    expect(runVercelCaptureStdout.mock.calls[0]?.[0]).toEqual(
      expect.arrayContaining(["delete", "wh_old"]),
    );
  });
});
