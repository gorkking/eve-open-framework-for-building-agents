import { relative, resolve } from "node:path";

import type { AgentCollection } from "#internal/agent-collection.js";
import { resolveAgentCollectionDeploymentMode } from "#internal/vercel/agent-collection-deployment.js";
import {
  createEveRequestPathRoute,
  createEveServiceRouteSrc,
} from "#internal/vercel/eve-service-contribution.js";
import {
  createServiceConfigRecord,
  readVercelJsonFile,
  type VercelRewriteConfig,
  type VercelRouteConfig,
  type VercelServiceConfig,
} from "#internal/vercel/vercel-services-config.js";

export interface AuthoredAgentServicesValidation {
  readonly omittedAgentNames: readonly string[];
}

function toPosixPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function sameRequestPathRoute(route: VercelRouteConfig, expected: VercelRouteConfig): boolean {
  if (route.src !== expected.src || route.transforms?.length !== 1) return false;
  const transform = route.transforms[0];
  const expectedTransform = expected.transforms?.[0];
  return (
    transform?.args === expectedTransform?.args &&
    transform?.op === expectedTransform?.op &&
    transform?.type === expectedTransform?.type
  );
}

function isCanonicalRewrite(
  route: VercelRewriteConfig,
  source: string,
  serviceName: string,
): boolean {
  return (
    route.source === source &&
    typeof route.destination === "object" &&
    route.destination.service === serviceName
  );
}

function resolveServiceForMember(input: {
  readonly collection: AgentCollection;
  readonly memberRoot: string;
  readonly services: Record<string, VercelServiceConfig>;
}): { readonly name: string; readonly service: VercelServiceConfig } | undefined {
  const matches = Object.entries(input.services).filter(([, service]) => {
    if (typeof service.root !== "string") return false;
    return resolve(input.collection.root, service.root) === resolve(input.memberRoot);
  });
  if (matches.length > 1) {
    throw new Error(
      `vercel.json declares multiple services rooted at ${toPosixPath(relative(input.collection.root, input.memberRoot))}. Each collection agent may have at most one service.`,
    );
  }
  const match = matches[0];
  return match === undefined ? undefined : { name: match[0], service: match[1] };
}

/** Validate canonical eve routing for collection members selected by an authored graph. */
export async function validateAuthoredAgentServices(
  collection: AgentCollection,
): Promise<AuthoredAgentServicesValidation> {
  if ((await resolveAgentCollectionDeploymentMode(collection)) !== "authored") {
    return { omittedAgentNames: [] };
  }
  const config = await readVercelJsonFile(`${collection.root}/vercel.json`);
  if (config.services === undefined) {
    throw new Error(
      "Use stable vercel.json#services for an authored eve collection; experimentalServices and experimentalServicesV2 are not supported.",
    );
  }
  const services = createServiceConfigRecord(config.services);
  const rewrites = config.rewrites ?? [];
  const omittedAgentNames: string[] = [];

  for (const member of collection.members) {
    const entry = resolveServiceForMember({
      collection,
      memberRoot: member.appRoot,
      services,
    });
    if (entry === undefined) {
      omittedAgentNames.push(member.name);
      continue;
    }
    if (entry.service.framework !== "eve") {
      throw new Error(
        `Vercel service ${JSON.stringify(entry.name)} targets agents/${member.name} but must set framework to "eve".`,
      );
    }

    const publicPrefix = `/eve/agents/${member.name}`;
    const routeSrc = createEveServiceRouteSrc(publicPrefix);
    const requestPathRoute = createEveRequestPathRoute(routeSrc);
    if (
      !(entry.service.routes ?? []).some((route) => sameRequestPathRoute(route, requestPathRoute))
    ) {
      throw new Error(
        `Vercel service ${JSON.stringify(entry.name)} must include eve's canonical request.path route for ${publicPrefix}/eve/v1/*.`,
      );
    }
    const rewriteSource = `${publicPrefix}/eve/v1/(.*)`;
    if (!rewrites.some((route) => isCanonicalRewrite(route, rewriteSource, entry.name))) {
      throw new Error(
        `vercel.json must rewrite ${rewriteSource} to service ${JSON.stringify(entry.name)}.`,
      );
    }
  }

  return { omittedAgentNames };
}
