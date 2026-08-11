import {
  createEvePublicRoute,
  createEveRequestPathRoute,
  createEveServiceName,
  type EveVercelAgentTarget,
} from "#internal/vercel/eve-service-contribution.js";
import {
  type GeneratedVercelServiceConfig,
  type VercelRouteConfig,
  type VercelServiceConfig,
} from "#internal/vercel/vercel-services-config.js";

export type MutableGeneratedVercelServiceConfig = {
  -readonly [Key in keyof GeneratedVercelServiceConfig]: GeneratedVercelServiceConfig[Key];
};

export function resolveServicePrefix(service: VercelServiceConfig | undefined): string | undefined {
  if (typeof service?.routePrefix === "string" && service.routePrefix.trim().length > 0) {
    return service.routePrefix.trim();
  }
  if (typeof service?.mount === "string" && service.mount.trim().length > 0) {
    return service.mount.trim();
  }
  if (
    typeof service?.mount === "object" &&
    typeof service.mount.path === "string" &&
    service.mount.path.trim().length > 0
  ) {
    return service.mount.path.trim();
  }
  return undefined;
}

export function findConfiguredEveServiceEntry(
  services: Record<string, VercelServiceConfig>,
  agent: EveVercelAgentTarget,
): { readonly name: string; readonly service: VercelServiceConfig } | undefined {
  if (agent.name !== undefined) {
    const name = createEveServiceName(agent.name);
    const service = services[name];
    return service?.framework === "eve" ? { name, service } : undefined;
  }
  const entry = Object.entries(services).find(([, service]) => service.framework === "eve");
  return entry === undefined ? undefined : { name: entry[0], service: entry[1] };
}

export function insertEveServiceRequestPathRoute(
  routes: readonly VercelRouteConfig[] | undefined,
  routeSrc: string,
): readonly VercelRouteConfig[] {
  return [
    createEveRequestPathRoute(routeSrc),
    ...(routes ?? []).filter((route) => route.src !== routeSrc),
  ];
}

function isEveServiceRoute(
  route: VercelRouteConfig,
  serviceName: string,
  routeSrc: string,
): boolean {
  const destination = route.destination;
  return (
    route.src === routeSrc &&
    typeof destination === "object" &&
    destination.type === "service" &&
    destination.service === serviceName
  );
}

export function insertEveServiceRoutes(
  routes: readonly VercelRouteConfig[],
  eveRoutes: readonly { readonly routeSrc: string; readonly serviceName: string }[],
): readonly VercelRouteConfig[] {
  const retained = routes.filter(
    (route) =>
      !eveRoutes.some(({ routeSrc, serviceName }) =>
        isEveServiceRoute(route, serviceName, routeSrc),
      ),
  );
  const generated = eveRoutes.map(({ routeSrc, serviceName }) =>
    createEvePublicRoute(serviceName, routeSrc),
  );
  const filesystemIndex = retained.findIndex((route) => route.handle === "filesystem");
  return filesystemIndex < 0
    ? [...generated, ...retained]
    : [...retained.slice(0, filesystemIndex), ...generated, ...retained.slice(filesystemIndex)];
}
