import { join } from "node:path";

import type { AgentCollection } from "#internal/agent-collection.js";
import { readVercelJsonFile } from "#internal/vercel/vercel-services-config.js";
import { assertValidVercelServiceName } from "#internal/vercel/vercel-service-name.js";

export type AgentCollectionDeploymentMode = "authored" | "inferred";

/** Resolve and validate the Vercel deployment policy for an agent collection. */
export async function resolveAgentCollectionDeploymentMode(
  collection: AgentCollection,
): Promise<AgentCollectionDeploymentMode> {
  for (const member of collection.members) {
    assertValidVercelServiceName(`eve-${member.name}`, "Generated agent collection service name");
  }

  const config = await readVercelJsonFile(join(collection.root, "vercel.json"));
  return config.services !== undefined ||
    config.experimentalServices !== undefined ||
    config.experimentalServicesV2 !== undefined
    ? "authored"
    : "inferred";
}
