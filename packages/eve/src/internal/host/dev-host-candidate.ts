import { join } from "node:path";

import { buildApplicationBundle } from "#internal/host/application-bundler.js";
import type { PreparedDevelopmentApplicationHost } from "#internal/host/types.js";

export interface DevelopmentWorkerPayload {
  readonly entry: string;
  readonly workerData: Readonly<Record<string, unknown>>;
}

/** Builds one immutable Rolldown worker candidate for the drained dev server. */
export async function buildDevelopmentHostCandidate(input: {
  readonly host: PreparedDevelopmentApplicationHost;
}): Promise<DevelopmentWorkerPayload> {
  const result = await buildApplicationBundle({
    host: input.host,
    serverDirectory: join(input.host.workspace.hostOutputDir, "server"),
    target: "development",
  });

  return {
    entry: result.entryPath,
    workerData: {},
  };
}
