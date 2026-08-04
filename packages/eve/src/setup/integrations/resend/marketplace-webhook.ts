import { runVercelCaptureStdout } from "#setup/primitives/run-vercel.js";
import { z } from "zod";

const RESULT_PREFIX = "EVE_RESEND_RESULT=";

const ReconcileResultSchema = z.object({
  id: z.string().min(1),
  signingSecret: z.string().min(1),
  previousIds: z.array(z.string().min(1)),
});

/** Newly created Resend webhook plus exact-match webhooks it supersedes. */
export type MarketplaceWebhookReconciliation = z.infer<typeof ReconcileResultSchema>;

export interface MarketplaceWebhookDeps {
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

const defaultDeps: MarketplaceWebhookDeps = { runVercelCaptureStdout };

const WEBHOOK_HELPER = String.raw`
const action = process.argv[1];
const values = process.argv.slice(2);
const key = process.env.RESEND_API_KEY;
if (!key) throw new Error("Marketplace did not provide RESEND_API_KEY to production.");
const headers = { Authorization: "Bearer " + key, "Content-Type": "application/json" };
async function request(path, init = {}) {
  const response = await fetch("https://api.resend.com" + path, { ...init, headers });
  if (!response.ok) throw new Error("Resend webhook request failed with HTTP " + response.status + ".");
  if (response.status === 204) return undefined;
  return response.json();
}
function normalize(value) {
  const url = new URL(value);
  url.hash = "";
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.href;
}
if (action === "reconcile") {
  const endpoint = values[0];
  if (!endpoint) throw new Error("Webhook endpoint is required.");
  const listed = await request("/webhooks");
  const webhooks = Array.isArray(listed?.data) ? listed.data : [];
  const previousIds = webhooks
    .filter((webhook) => typeof webhook?.id === "string" && typeof webhook?.endpoint === "string" && normalize(webhook.endpoint) === normalize(endpoint))
    .map((webhook) => webhook.id);
  const createdBody = await request("/webhooks", {
    method: "POST",
    body: JSON.stringify({ endpoint, events: ["email.received"] }),
  });
  const created = createdBody?.data ?? createdBody;
  if (typeof created?.id !== "string" || typeof created?.signing_secret !== "string") {
    throw new Error("Resend did not return the new webhook signing secret.");
  }
  console.log(${JSON.stringify(RESULT_PREFIX)} + Buffer.from(JSON.stringify({ id: created.id, signingSecret: created.signing_secret, previousIds }), "utf8").toString("base64url"));
} else if (action === "delete") {
  for (const id of values) await request("/webhooks/" + encodeURIComponent(id), { method: "DELETE" });
  console.log(${JSON.stringify(RESULT_PREFIX)} + Buffer.from(JSON.stringify({ deleted: values }), "utf8").toString("base64url"));
} else {
  throw new Error("Unknown Resend webhook helper action.");
}
`;

function parseResult(stdout: string): unknown {
  const line = stdout.split(/\r?\n/u).findLast((candidate) => candidate.startsWith(RESULT_PREFIX));
  if (line === undefined) throw new Error("Resend webhook setup returned no result.");
  try {
    return JSON.parse(
      Buffer.from(line.slice(RESULT_PREFIX.length), "base64url").toString("utf8"),
    ) as unknown;
  } catch {
    throw new Error("Resend webhook setup returned an invalid result.");
  }
}

async function runMarketplaceWebhookHelper(input: {
  args: string[];
  projectRoot: string;
  orgId: string;
  signal?: AbortSignal;
  deps?: MarketplaceWebhookDeps;
}): Promise<unknown> {
  const deps = input.deps ?? defaultDeps;
  const result = await deps.runVercelCaptureStdout(
    [
      "env",
      "run",
      "--environment",
      "production",
      "--scope",
      input.orgId,
      "--",
      process.execPath,
      "--input-type=module",
      "--eval",
      WEBHOOK_HELPER,
      ...input.args,
    ],
    { cwd: input.projectRoot, nonInteractive: true, signal: input.signal },
  );
  if (!result.ok) {
    throw new Error(
      "Could not configure the Resend webhook with the Marketplace project credential.",
    );
  }
  return parseResult(result.stdout);
}

/** Creates a replacement webhook using Marketplace's production credential. */
export async function reconcileMarketplaceResendWebhook(input: {
  endpoint: string;
  projectRoot: string;
  orgId: string;
  signal?: AbortSignal;
  deps?: MarketplaceWebhookDeps;
}): Promise<MarketplaceWebhookReconciliation> {
  const parsed = ReconcileResultSchema.safeParse(
    await runMarketplaceWebhookHelper({ ...input, args: ["reconcile", input.endpoint] }),
  );
  if (!parsed.success) throw new Error("Resend webhook setup returned an invalid webhook.");
  return parsed.data;
}

/** Deletes webhooks using Marketplace's production credential. */
export async function deleteMarketplaceResendWebhooks(input: {
  ids: readonly string[];
  projectRoot: string;
  orgId: string;
  signal?: AbortSignal;
  deps?: MarketplaceWebhookDeps;
}): Promise<void> {
  if (input.ids.length === 0) return;
  await runMarketplaceWebhookHelper({ ...input, args: ["delete", ...input.ids] });
}
