import { join, relative } from "node:path";

import {
  EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV,
  EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV,
} from "#internal/application/paths.js";
import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import {
  EVE_PUBLIC_ROUTE_PREFIX_ENV,
  normalizePublicRoutePrefix,
} from "#shared/public-route-prefix.js";
import type {
  GeneratedVercelServiceConfig,
  VercelRouteConfig,
} from "#internal/vercel/vercel-services-config.js";

const EVE_VERCEL_SERVICES_DIRECTORY = ".eve/vercel-services";

export interface EveVercelAgentTarget {
  readonly appRoot: string;
  readonly buildCommand: string;
  readonly name?: string;
  readonly publicRoutePrefix: string;
}

export type EveVercelBuildTarget =
  | {
      readonly kind: "direct";
      readonly projectRoot: string;
      readonly root: string;
    }
  | {
      readonly hostOutputDirectory: string;
      readonly kind: "isolated";
      readonly projectRoot: string;
    };

export interface EveVercelServiceContribution {
  readonly publicRoute: VercelRouteConfig;
  readonly rootDirectory: string;
  readonly routeSrc: string;
  readonly service: GeneratedVercelServiceConfig;
  readonly serviceName: string;
}

function toRelativePath(fromRoot: string, toRoot: string): string {
  const path = relative(fromRoot, toRoot).replaceAll("\\", "/");
  return path.length === 0 ? "." : path;
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function createEveServiceName(name: string | undefined): string {
  return name === undefined ? "eve" : `eve-${name}`;
}

export function createEveServiceRouteSrc(publicRoutePrefix: string): string {
  if (publicRoutePrefix.length === 0) return `^${EVE_ROUTE_PREFIX}/(.*)$`;
  const prefix = publicRoutePrefix.startsWith("/") ? publicRoutePrefix : `/${publicRoutePrefix}`;
  return `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${EVE_ROUTE_PREFIX}/(.*)$`;
}

export function createEveRequestPathRoute(routeSrc: string): VercelRouteConfig {
  return {
    src: routeSrc,
    transforms: [{ args: `${EVE_ROUTE_PREFIX}/$1`, op: "set", type: "request.path" }],
  };
}

export function createEvePublicRoute(serviceName: string, routeSrc: string): VercelRouteConfig {
  return { destination: { service: serviceName, type: "service" }, src: routeSrc };
}

function createDirectBuildCommand(agent: EveVercelAgentTarget): string {
  const prefix = normalizePublicRoutePrefix(agent.publicRoutePrefix);
  return prefix === undefined
    ? agent.buildCommand
    : `export ${EVE_PUBLIC_ROUTE_PREFIX_ENV}=${quoteShellArgument(prefix)} && ${agent.buildCommand}`;
}

function createIsolatedBuild(input: {
  readonly agent: EveVercelAgentTarget;
  readonly hostOutputDirectory: string;
  readonly projectRoot: string;
  readonly serviceName: string;
}): { readonly buildCommand: string; readonly root: string; readonly rootDirectory: string } {
  const rootDirectory = join(input.projectRoot, EVE_VERCEL_SERVICES_DIRECTORY, input.serviceName);
  const outputDirectory = join(rootDirectory, ".vercel", "output");
  const prefix = normalizePublicRoutePrefix(input.agent.publicRoutePrefix);
  const prefixExport =
    prefix === undefined
      ? ""
      : ` && export ${EVE_PUBLIC_ROUTE_PREFIX_ENV}=${quoteShellArgument(prefix)}`;

  return {
    buildCommand: `cd ${quoteShellArgument(toRelativePath(rootDirectory, input.agent.appRoot))} && export ${EVE_INTERNAL_BUILD_OUTPUT_DIRECTORY_ENV}=${quoteShellArgument(toRelativePath(input.agent.appRoot, outputDirectory))} && export ${EVE_INTERNAL_HOST_BUILD_OUTPUT_DIRECTORY_ENV}=${quoteShellArgument(toRelativePath(input.agent.appRoot, input.hostOutputDirectory))}${prefixExport} && ${input.agent.buildCommand}`,
    root: toRelativePath(input.projectRoot, rootDirectory),
    rootDirectory,
  };
}

/** Compile one eve agent into its complete Vercel service and ingress contribution. */
export function compileEveVercelService(input: {
  readonly agent: EveVercelAgentTarget;
  readonly target: EveVercelBuildTarget;
}): EveVercelServiceContribution {
  const serviceName = createEveServiceName(input.agent.name);
  const routeSrc = createEveServiceRouteSrc(input.agent.publicRoutePrefix);
  const build =
    input.target.kind === "direct"
      ? {
          buildCommand: createDirectBuildCommand(input.agent),
          root: input.target.root,
          rootDirectory: input.agent.appRoot,
        }
      : createIsolatedBuild({
          agent: input.agent,
          hostOutputDirectory: input.target.hostOutputDirectory,
          projectRoot: input.target.projectRoot,
          serviceName,
        });

  return {
    publicRoute: createEvePublicRoute(serviceName, routeSrc),
    rootDirectory: build.rootDirectory,
    routeSrc,
    service: {
      buildCommand: build.buildCommand,
      framework: "eve",
      root: build.root,
      routes: [createEveRequestPathRoute(routeSrc)],
      ...(input.agent.publicRoutePrefix.length > 0
        ? { routePrefix: input.agent.publicRoutePrefix }
        : {}),
    },
    serviceName,
  };
}
