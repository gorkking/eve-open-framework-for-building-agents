import type { ChannelSetupLog } from "#setup/cli/index.js";
import { createPromptCommandOutput, withPhase } from "#setup/cli/index.js";
import type { VercelProjectReference } from "#setup/project-resolution.js";
import {
  runVercel,
  runVercelCaptureStdout,
  type RunVercelCaptureResult,
} from "#setup/primitives/run-vercel.js";

export const PHOTON_CONNECT_SERVICE = "spectrum.photon.codes";
export const PHOTON_CONNECTOR_TYPE = "api-key";
export const PHOTON_TRIGGER_PATH = "/eve/v1/imessage";

/** Photon project credentials collected separately from their Connect storage encoding. */
export interface PhotonProjectCredentials {
  projectId: string;
  projectSecret: string;
}

/** Identity of a Photon API-key connector created through Vercel Connect. */
export interface PhotonConnectorRef {
  id: string;
  uid: string;
  /** Direct project URL used until Photon is available as a managed trigger connector. */
  webhookUrl?: string;
}

/** Effects used to provision a Photon connector. */
export interface ProvisionPhotonConnectorDeps {
  runVercel: typeof runVercel;
  runVercelCaptureStdout: typeof runVercelCaptureStdout;
}

/** Input for provisioning one Photon connector and its eve webhook destination. */
export interface ProvisionPhotonConnectorOptions {
  credentials: PhotonProjectCredentials;
  log: ChannelSetupLog;
  project: VercelProjectReference;
  projectRoot: string;
  slug: string;
  signal?: AbortSignal;
  deps?: ProvisionPhotonConnectorDeps;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Encodes Photon Basic-auth credentials as the single value stored by the preset. */
export function encodePhotonConnectCredential(credentials: PhotonProjectCredentials): string {
  const projectId = credentials.projectId.trim();
  const projectSecret = credentials.projectSecret.trim();
  if (!projectId || !projectSecret) {
    throw new Error("Photon project ID and project secret are required.");
  }
  if (projectId.includes(":")) {
    throw new Error("Photon project ID cannot contain a colon.");
  }
  return `${projectId}:${projectSecret}`;
}

/** Parses `vercel connect create -F json` output for a Photon API-key connector. */
export function parseCreatedPhotonConnector(stdout: string): PhotonConnectorRef | undefined {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["uid"] !== "string") {
    return undefined;
  }
  const subjects = value["supportedSubjectTypes"];
  if (!Array.isArray(subjects) || !subjects.includes("app")) return undefined;
  return { id: value["id"], uid: value["uid"] };
}

function createData(credentials: PhotonProjectCredentials): string {
  return JSON.stringify({ values: [{ value: encodePhotonConnectCredential(credentials) }] });
}

function parseProjectDomain(stdout: string): string | undefined {
  try {
    const value: unknown = JSON.parse(stdout);
    if (!isRecord(value) || !Array.isArray(value["domains"])) return undefined;
    const domain = value["domains"].find(
      (candidate) => isRecord(candidate) && typeof candidate["name"] === "string",
    );
    return isRecord(domain) && typeof domain["name"] === "string"
      ? `https://${domain["name"]}${PHOTON_TRIGGER_PATH}`
      : undefined;
  } catch {
    return undefined;
  }
}

function requireCreatedConnector(result: RunVercelCaptureResult): PhotonConnectorRef {
  if (!result.ok) throw new Error("Photon connector creation failed.");
  const connector = parseCreatedPhotonConnector(result.stdout);
  if (connector === undefined) {
    throw new Error("Vercel returned an invalid Photon connector after creation.");
  }
  return connector;
}

/**
 * Creates a Photon API-key connector and attaches the linked project. Photon
 * webhooks go directly to the project's eve route until the managed Photon
 * connector supports trigger forwarding. Secrets travel over stdin, never argv.
 */
export async function provisionPhotonConnector(
  options: ProvisionPhotonConnectorOptions,
): Promise<PhotonConnectorRef> {
  const deps = options.deps ?? { runVercel, runVercelCaptureStdout };
  const onOutput = createPromptCommandOutput(options.log);
  const result = await withPhase(options.log, "Creating Photon connector...", () =>
    deps.runVercelCaptureStdout(
      [
        "connect",
        "create",
        PHOTON_CONNECT_SERVICE,
        "--connector-type",
        PHOTON_CONNECTOR_TYPE,
        "--data",
        "@-",
        "--name",
        options.slug,
        "-F",
        "json",
        "--scope",
        options.project.orgId,
      ],
      {
        cwd: options.projectRoot,
        nonInteractive: true,
        onOutput,
        signal: options.signal,
        stdin: createData(options.credentials),
      },
    ),
  );
  options.signal?.throwIfAborted();
  const connector = requireCreatedConnector(result);

  const attached = await withPhase(options.log, "Connecting Photon credentials...", () =>
    deps.runVercel(
      [
        "connect",
        "attach",
        connector.uid,
        "--project",
        options.project.projectId,
        "--environment",
        "production",
        "--yes",
        "--scope",
        options.project.orgId,
      ],
      {
        cwd: options.projectRoot,
        nonInteractive: true,
        onOutput,
        signal: options.signal,
      },
    ),
  );
  options.signal?.throwIfAborted();
  if (!attached) {
    throw new Error(
      `Photon connector was created, but its credentials could not be attached. Run \`vercel connect attach ${connector.uid} --environment production --yes\`.`,
    );
  }

  const domains = await deps.runVercelCaptureStdout(
    [
      "api",
      `/v9/projects/${options.project.projectId}/domains?teamId=${options.project.orgId}`,
      "--scope",
      options.project.orgId,
    ],
    {
      cwd: options.projectRoot,
      nonInteractive: true,
      onOutput,
      signal: options.signal,
    },
  );
  const webhookUrl = domains.ok ? parseProjectDomain(domains.stdout) : undefined;
  if (webhookUrl === undefined) {
    throw new Error(
      "Photon credentials were connected, but eve could not resolve the project URL.",
    );
  }
  return { ...connector, webhookUrl };
}
