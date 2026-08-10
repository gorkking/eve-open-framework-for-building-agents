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

export interface VercelRequestPathTransform {
  readonly args: string;
  readonly op: "set";
  readonly type: "request.path";
}

export interface VercelRouteConfig {
  readonly destination?: string | VercelServiceRouteDestination;
  readonly handle?: string;
  readonly src?: string;
  readonly transforms?: readonly VercelRequestPathTransform[];
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

function parseServiceConfig(value: unknown, path: string): VercelServiceConfig {
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object.`);
  return value as VercelServiceConfig;
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
      return { ...config, name } as VercelServiceConfig & { readonly name: string };
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
  if (value.routes !== undefined && !Array.isArray(value.routes)) {
    throw new Error(`${fileName} routes must be an array.`);
  }
  if (value.rewrites !== undefined && !Array.isArray(value.rewrites)) {
    throw new Error(`${fileName} rewrites must be an array.`);
  }
  const config: Record<string, unknown> = { ...value };
  if (services !== undefined) config.services = services;
  return config as VercelServicesConfig;
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
