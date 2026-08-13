import type { NormalizedChannelCorsOptions } from "#channel/cors.js";
import type { ChannelRouteMethod } from "#public/definitions/channel.js";
import {
  EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
  EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
  EVE_HEALTH_ROUTE_PATH,
  EVE_WORKFLOW_FLOW_ROUTE_PATH,
} from "#protocol/routes.js";
import {
  getAllFrameworkChannelNames,
  getFrameworkChannelDefinitions,
} from "#runtime/framework-channels/index.js";
import type { ScheduleRegistration } from "#runtime/schedules/register.js";
import type { CompiledAgentManifest } from "#compiler/manifest.js";
import { createVercelCronHandlerRoute } from "#internal/host/vercel-cron-handler.js";

export type ApplicationRouteMethod =
  | "ALL"
  | "DELETE"
  | "GET"
  | "HEAD"
  | "OPTIONS"
  | "PATCH"
  | "POST"
  | "PUT"
  | "WEBSOCKET";

export interface ApplicationChannelRouteRegistration {
  readonly method: ChannelRouteMethod;
  readonly route: string;
  readonly cors?: NormalizedChannelCorsOptions;
}

export type ApplicationRouteKind =
  | "channel"
  | "channel-preflight"
  | "development-artifacts"
  | "development-schedule"
  | "health"
  | "home"
  | "vercel-cron"
  | "workflow";

/** One method/path binding consumed by the generated H3 application. */
export interface ApplicationRouteRegistration {
  readonly kind: ApplicationRouteKind;
  readonly method: ApplicationRouteMethod;
  readonly path: string;
  readonly cors?: NormalizedChannelCorsOptions;
}

/** Path-only view accepted directly by the Vercel Build Output emitter. */
export interface ApplicationVercelRoute {
  readonly path: string;
}

export interface ApplicationVercelCron {
  readonly path: string;
  readonly schedule: string;
}

export interface ApplicationRouteRegistry {
  /** Globally deduplicated H3 method/path bindings in registration order. */
  readonly routes: readonly ApplicationRouteRegistration[];
  /** Active channel bindings after framework override and route deduplication. */
  readonly channelRegistrations: readonly ApplicationChannelRouteRegistration[];
  /** Unique path list shared by host-build diagnostics and fingerprints. */
  readonly routePaths: readonly string[];
  /** Unique path-only projection passed to `emitVercelBuildOutput`. */
  readonly vercelRoutes: readonly ApplicationVercelRoute[];
  /** Schedule entries passed to `emitVercelBuildOutput` when cron is enabled. */
  readonly vercelCrons: readonly ApplicationVercelCron[];
  /** Unguessable handler path shared by the H3 route and every Vercel cron. */
  readonly vercelCronRoute?: string;
}

export interface CreateApplicationRouteRegistryOptions {
  readonly development?: boolean;
  /** Generates one random handler path for this build when true. */
  readonly vercelCron?: boolean;
}

export interface ApplicationRouteRegistryHost {
  readonly compileResult: {
    readonly manifest: Pick<CompiledAgentManifest, "channels">;
  };
  readonly scheduleRegistrations: readonly Pick<ScheduleRegistration, "cron">[];
}

export type ApplicationChannelManifestEntry =
  | {
      readonly kind: "channel";
      readonly name: string;
      readonly method: ChannelRouteMethod;
      readonly urlPath: string;
      readonly cors?: NormalizedChannelCorsOptions;
    }
  | {
      readonly kind: "disabled";
      readonly name: string;
    };

export interface ApplicationFrameworkChannelDefinition {
  readonly name: string;
  readonly method: ChannelRouteMethod;
  readonly urlPath: string;
  readonly cors?: NormalizedChannelCorsOptions;
}

export interface MergeApplicationChannelRoutesInput {
  readonly frameworkChannelNames: ReadonlySet<string>;
  readonly frameworkChannels: readonly ApplicationFrameworkChannelDefinition[];
  readonly manifestChannels: readonly ApplicationChannelManifestEntry[];
}

export interface CreateApplicationRouteRegistryInput extends MergeApplicationChannelRoutesInput {
  readonly development?: boolean;
  readonly scheduleRegistrations: readonly Pick<ScheduleRegistration, "cron">[];
  /** Explicit route used by the pure builder; the host wrapper generates it. */
  readonly vercelCronRoute?: string;
}

const PACKAGE_ROUTES: readonly ApplicationRouteRegistration[] = [
  { kind: "home", method: "GET", path: "/" },
  { kind: "health", method: "GET", path: EVE_HEALTH_ROUTE_PATH },
  { kind: "health", method: "HEAD", path: EVE_HEALTH_ROUTE_PATH },
];

function createMethodPathKey(input: {
  readonly method: ApplicationRouteMethod;
  readonly path: string;
}): string {
  return `${input.method} ${input.path}`;
}

function assertRoutePath(path: string): void {
  if (!path.startsWith("/") || path.includes("?") || path.includes("#") || path.includes("\0")) {
    throw new Error(`Application route must be an absolute URL path: ${JSON.stringify(path)}.`);
  }
}

/**
 * Applies filesystem channel precedence without importing a host or router.
 * An authored channel name replaces all defaults with that name; a disabled
 * entry removes them. Remaining framework routes are ordered first, so they
 * win a method/path collision with a differently-named authored channel.
 */
export function mergeApplicationChannelRouteRegistrations(
  input: MergeApplicationChannelRoutesInput,
): readonly ApplicationChannelRouteRegistration[] {
  const authoredNames = new Set<string>();
  const authoredRoutes: ApplicationChannelRouteRegistration[] = [];
  const disabledNames = new Set<string>();

  for (const entry of input.manifestChannels) {
    if (entry.kind === "disabled") {
      if (!input.frameworkChannelNames.has(entry.name)) {
        throw new Error(
          `agent/channels/${entry.name}.ts exports disableRoute() but "${entry.name}" is not a framework channel. ` +
            `Rename the file to one of: ${[...input.frameworkChannelNames].sort().join(", ")}.`,
        );
      }
      disabledNames.add(entry.name);
      continue;
    }

    assertRoutePath(entry.urlPath);
    authoredNames.add(entry.name);
    authoredRoutes.push(
      entry.cors === undefined
        ? { method: entry.method, route: entry.urlPath }
        : { cors: entry.cors, method: entry.method, route: entry.urlPath },
    );
  }

  const activeFrameworkRoutes = input.frameworkChannels
    .filter((channel) => !authoredNames.has(channel.name) && !disabledNames.has(channel.name))
    .map((channel): ApplicationChannelRouteRegistration => {
      assertRoutePath(channel.urlPath);
      return channel.cors === undefined
        ? { method: channel.method, route: channel.urlPath }
        : { cors: channel.cors, method: channel.method, route: channel.urlPath };
    });

  const seen = new Set<string>();
  const merged: ApplicationChannelRouteRegistration[] = [];
  for (const registration of [...activeFrameworkRoutes, ...authoredRoutes]) {
    const key = createMethodPathKey({
      method: registration.method,
      path: registration.route,
    });
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(registration);
    }
  }

  return merged;
}

/**
 * Pure registry builder used by tests and the PreparedApplicationHost wrapper.
 * Package routes retain precedence over channel collisions; channel routes
 * retain precedence over workflow/dev routes to match the previous host's
 * registration order. CORS preflight is emitted once for each channel path.
 */
export function createApplicationRouteRegistryFromInput(
  input: CreateApplicationRouteRegistryInput,
): ApplicationRouteRegistry {
  const vercelCronRoute = input.vercelCronRoute;
  const mergedChannels = mergeApplicationChannelRouteRegistrations(input);
  const routes: ApplicationRouteRegistration[] = [];
  const acceptedChannels: ApplicationChannelRouteRegistration[] = [];
  const methodPaths = new Set<string>();

  const addRoute = (route: ApplicationRouteRegistration): boolean => {
    assertRoutePath(route.path);
    const key = createMethodPathKey(route);
    if (methodPaths.has(key)) {
      return false;
    }
    methodPaths.add(key);
    routes.push(route);
    return true;
  };

  for (const route of PACKAGE_ROUTES) {
    addRoute(route);
  }

  const preflightPaths = new Set<string>();
  for (const channel of mergedChannels) {
    const accepted = addRoute(
      channel.cors === undefined
        ? { kind: "channel", method: channel.method, path: channel.route }
        : {
            cors: channel.cors,
            kind: "channel",
            method: channel.method,
            path: channel.route,
          },
    );
    if (!accepted) {
      continue;
    }
    acceptedChannels.push(channel);

    if (channel.cors !== undefined && !preflightPaths.has(channel.route)) {
      preflightPaths.add(channel.route);
      addRoute({
        cors: channel.cors,
        kind: "channel-preflight",
        method: "OPTIONS",
        path: channel.route,
      });
    }
  }

  addRoute({
    kind: "workflow",
    method: "POST",
    path: EVE_WORKFLOW_FLOW_ROUTE_PATH,
  });

  if (input.development === true) {
    addRoute({
      kind: "development-artifacts",
      method: "GET",
      path: EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
    });
    addRoute({
      kind: "development-schedule",
      method: "POST",
      path: EVE_DEV_DISPATCH_SCHEDULE_ROUTE_PATTERN,
    });
  }

  if (vercelCronRoute !== undefined) {
    addRoute({
      kind: "vercel-cron",
      method: "ALL",
      path: vercelCronRoute,
    });
  }

  const routePaths = Array.from(new Set(routes.map((route) => route.path)));
  const cronSchedules = Array.from(
    new Set(input.scheduleRegistrations.map((registration) => registration.cron)),
  );

  const registry: ApplicationRouteRegistry = {
    routes,
    channelRegistrations: acceptedChannels,
    routePaths,
    vercelRoutes: routePaths.map((path) => ({ path })),
    vercelCrons:
      vercelCronRoute === undefined
        ? []
        : cronSchedules.map((schedule) => ({
            path: vercelCronRoute,
            schedule,
          })),
  };
  return vercelCronRoute === undefined ? registry : { ...registry, vercelCronRoute };
}

/** Projects one compiled application into the shared route topology. */
export function createApplicationRouteRegistry(
  preparedHost: ApplicationRouteRegistryHost,
  options: CreateApplicationRouteRegistryOptions = {},
): ApplicationRouteRegistry {
  return createApplicationRouteRegistryFromInput({
    development: options.development,
    frameworkChannelNames: getAllFrameworkChannelNames(),
    frameworkChannels: getFrameworkChannelDefinitions(),
    manifestChannels: preparedHost.compileResult.manifest.channels,
    scheduleRegistrations: preparedHost.scheduleRegistrations,
    vercelCronRoute: options.vercelCron === true ? createVercelCronHandlerRoute() : undefined,
  });
}

/** Channel-only projection for callers that only need registrations. */
export function computeApplicationChannelRouteRegistrations(
  preparedHost: ApplicationRouteRegistryHost,
): readonly ApplicationChannelRouteRegistration[] {
  return mergeApplicationChannelRouteRegistrations({
    frameworkChannelNames: getAllFrameworkChannelNames(),
    frameworkChannels: getFrameworkChannelDefinitions(),
    manifestChannels: preparedHost.compileResult.manifest.channels,
  });
}
