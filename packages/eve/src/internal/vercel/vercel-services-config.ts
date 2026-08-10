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

export interface VercelNamedServiceConfig extends VercelServiceConfig {
  readonly name?: string;
}

export type VercelServicesCollection =
  | Record<string, VercelServiceConfig>
  | readonly VercelNamedServiceConfig[];

export interface VercelServicesConfig {
  readonly experimentalServices?: unknown;
  readonly experimentalServicesV2?: unknown;
  readonly routes?: readonly VercelRouteConfig[];
  readonly services?: VercelServicesCollection;
  readonly [key: string]: unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function createServiceConfigRecord(
  services: VercelServicesCollection | undefined,
): Record<string, VercelServiceConfig> {
  if (services === undefined) return {};
  if (!Array.isArray(services)) return services as Record<string, VercelServiceConfig>;

  return Object.fromEntries(
    services.flatMap(({ name, ...service }) =>
      typeof name === "string" && name.trim().length > 0 ? [[name, service]] : [],
    ),
  );
}

export function hasServices(
  services: VercelServicesCollection | undefined,
): services is VercelServicesCollection {
  return Object.keys(createServiceConfigRecord(services)).length > 0;
}

export async function readVercelJsonFile(path: string): Promise<VercelServicesConfig> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    if (!isRecord(parsed)) throw new Error(`${path} must contain a JSON object.`);
    return parsed as VercelServicesConfig;
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
