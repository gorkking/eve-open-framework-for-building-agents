import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface VercelServiceMount {
  readonly path?: string;
  readonly subdomain?: string;
}

export interface VercelServiceRouteDestination {
  readonly service?: string;
  readonly type?: string;
}

export interface VercelRouteTransform {
  readonly args?: string;
  readonly op?: string;
  readonly type?: string;
  readonly [key: string]: unknown;
}

export interface VercelRouteConfig {
  readonly destination?: string | VercelServiceRouteDestination;
  readonly handle?: string;
  readonly src?: string;
  readonly transforms?: readonly VercelRouteTransform[];
  readonly [key: string]: unknown;
}

export interface VercelServiceConfig {
  readonly buildCommand?: string;
  readonly entrypoint?: string;
  readonly framework?: string;
  readonly mount?: string | VercelServiceMount;
  readonly routes?: readonly VercelRouteConfig[];
  readonly routePrefix?: string;
  readonly root?: string;
  readonly type?: string;
}

export interface GeneratedVercelServiceConfig extends VercelServiceConfig {
  readonly buildCommand: string;
  readonly framework: "eve";
  readonly root: string;
  readonly routes: readonly VercelRouteConfig[];
}

export type VercelServicesCollection =
  | Record<string, VercelServiceConfig>
  | readonly (VercelServiceConfig & { readonly name: string })[];

export interface VercelServicesConfig {
  readonly experimentalServices?: unknown;
  readonly experimentalServicesV2?: unknown;
  readonly rewrites?: readonly unknown[];
  readonly routes?: readonly VercelRouteConfig[];
  readonly services?: VercelServicesCollection;
  readonly [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseOptionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${path} must be a string.`);
  return value;
}

function parseRouteTransform(value: unknown, path: string): VercelRouteTransform {
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object.`);
  return {
    ...value,
    args: parseOptionalString(value.args, `${path}.args`),
    op: parseOptionalString(value.op, `${path}.op`),
    type: parseOptionalString(value.type, `${path}.type`),
  };
}

function parseRoute(value: unknown, path: string): VercelRouteConfig {
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object.`);
  const destination = value.destination;
  if (destination !== undefined && typeof destination !== "string" && !isRecord(destination)) {
    throw new Error(`${path}.destination must be a string or JSON object.`);
  }
  const transforms = value.transforms;
  if (transforms !== undefined && !Array.isArray(transforms)) {
    throw new Error(`${path}.transforms must be an array.`);
  }
  return {
    ...value,
    destination:
      destination === undefined || typeof destination === "string"
        ? destination
        : {
            ...destination,
            service: parseOptionalString(destination.service, `${path}.destination.service`),
            type: parseOptionalString(destination.type, `${path}.destination.type`),
          },
    handle: parseOptionalString(value.handle, `${path}.handle`),
    src: parseOptionalString(value.src, `${path}.src`),
    transforms: transforms?.map((transform, index) =>
      parseRouteTransform(transform, `${path}.transforms[${index}]`),
    ),
  };
}

function parseRoutes(value: unknown, path: string): readonly VercelRouteConfig[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error(`${path} must be an array.`);
  return value.map((route, index) => parseRoute(route, `${path}[${index}]`));
}

function parseMount(value: unknown, path: string): string | VercelServiceMount | undefined {
  if (value === undefined || typeof value === "string") return value;
  if (!isRecord(value)) throw new Error(`${path} must be a string or JSON object.`);
  return {
    ...value,
    path: parseOptionalString(value.path, `${path}.path`),
    subdomain: parseOptionalString(value.subdomain, `${path}.subdomain`),
  };
}

function parseServiceConfig(value: unknown, path: string): VercelServiceConfig {
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object.`);
  return {
    ...value,
    buildCommand: parseOptionalString(value.buildCommand, `${path}.buildCommand`),
    entrypoint: parseOptionalString(value.entrypoint, `${path}.entrypoint`),
    framework: parseOptionalString(value.framework, `${path}.framework`),
    mount: parseMount(value.mount, `${path}.mount`),
    routes: parseRoutes(value.routes, `${path}.routes`),
    routePrefix: parseOptionalString(value.routePrefix, `${path}.routePrefix`),
    root: parseOptionalString(value.root, `${path}.root`),
    type: parseOptionalString(value.type, `${path}.type`),
  };
}

function parseServices(value: unknown, fileName: string): VercelServicesCollection | undefined {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    return value.map((service, index) => {
      if (!isRecord(service)) {
        throw new Error(`${fileName} services[${index}] must contain a JSON object.`);
      }
      if (typeof service.name !== "string" || service.name.trim().length === 0) {
        throw new Error(`${fileName} services[${index}] must have a non-empty name.`);
      }
      const { name, ...config } = service;
      return { ...parseServiceConfig(config, `${fileName} services[${index}]`), name };
    });
  }
  if (!isRecord(value)) {
    throw new Error(`${fileName} services must be a JSON object or named service array.`);
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, service]) => [
      name,
      parseServiceConfig(service, `${fileName} service ${JSON.stringify(name)}`),
    ]),
  );
}

/** Parse the Vercel configuration shape shared by root and Build Output configs. */
export function parseVercelServicesConfig(value: unknown, fileName: string): VercelServicesConfig {
  if (!isRecord(value)) throw new Error(`${fileName} must contain a JSON object.`);
  const services = parseServices(value.services, fileName);
  const routes = parseRoutes(value.routes, `${fileName} routes`);
  if (value.rewrites !== undefined && !Array.isArray(value.rewrites)) {
    throw new Error(`${fileName} rewrites must be an array.`);
  }
  return {
    ...value,
    routes,
    services,
  };
}

function isNamedServiceArray(
  services: VercelServicesCollection,
): services is readonly (VercelServiceConfig & { readonly name: string })[] {
  return Array.isArray(services);
}

export function createServiceConfigRecord(
  services: VercelServicesCollection | undefined,
): Record<string, VercelServiceConfig> {
  if (services === undefined) return {};
  if (!isNamedServiceArray(services)) return services;
  return Object.fromEntries(services.map(({ name, ...service }) => [name, service]));
}

export function hasServices(
  services: VercelServicesCollection | undefined,
): services is VercelServicesCollection {
  return Object.keys(createServiceConfigRecord(services)).length > 0;
}

export async function readVercelJsonFile(path: string): Promise<VercelServicesConfig> {
  try {
    return parseVercelServicesConfig(JSON.parse(await readFile(path, "utf8")) as unknown, path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return {};
    throw error;
  }
}

export async function writeVercelJsonFile(
  path: string,
  config: VercelServicesConfig,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(config, null, 2)}\n`);
}
