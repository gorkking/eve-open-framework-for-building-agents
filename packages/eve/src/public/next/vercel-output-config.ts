import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  createEveServiceName,
  createEveServiceRouteSrc,
  compileEveVercelService,
  createServiceConfigRecord,
  findConfiguredEveServiceEntry,
  hasServices,
  insertEveServiceRequestPathRoute,
  insertEveServiceRoutes,
  isRecord,
  resolveServicePrefix,
  type MutableGeneratedVercelServiceConfig,
  type VercelServiceConfig,
  type VercelServicesConfig,
} from "#internal/vercel/service-config-codegen.js";
import {
  findClosestLinkedVercelDirectory,
  findClosestVercelOutputDirectory,
} from "#shared/vercel-output-directory.js";

const VERCEL_JSON_FILE_NAME = "vercel.json";
const VERCEL_OUTPUT_CONFIG_FILE_NAME = ".vercel/output/config.json";
const VERCEL_BUILD_OUTPUT_VERSION = 3;

interface VercelOutputConfig extends VercelServicesConfig {
  readonly version?: number;
}

export interface EnsureVercelOutputConfigResult {
  readonly agents: readonly EnsureVercelOutputConfigAgentResult[];
}

export interface EnsureVercelOutputConfigAgentInput {
  readonly appRoot: string;
  readonly buildCommand: string;
  readonly name?: string;
  readonly publicRoutePrefix: string;
  readonly servicePrefix: string;
}

export interface EnsureVercelOutputConfigAgentResult {
  readonly name?: string;
  readonly servicePrefix: string;
}

async function resolveVercelOutputConfigLocation(nextRoot: string): Promise<{
  readonly canWriteGeneratedOutput: boolean;
  readonly outputConfigPath: string;
  readonly projectRoot: string;
}> {
  const vercelDirectory = await findClosestLinkedVercelDirectory(nextRoot);
  const projectRoot = vercelDirectory === undefined ? nextRoot : dirname(vercelDirectory);
  const outputDirectory = await findClosestVercelOutputDirectory(nextRoot);

  if (outputDirectory !== undefined) {
    return {
      canWriteGeneratedOutput: true,
      outputConfigPath: join(outputDirectory, "config.json"),
      projectRoot,
    };
  }

  if (vercelDirectory !== undefined) {
    return {
      canWriteGeneratedOutput: true,
      outputConfigPath: join(vercelDirectory, "output", "config.json"),
      projectRoot,
    };
  }

  return {
    canWriteGeneratedOutput: Boolean(process.env.VERCEL),
    outputConfigPath: join(nextRoot, VERCEL_OUTPUT_CONFIG_FILE_NAME),
    projectRoot,
  };
}

function normalizeVercelServicesConfig(value: unknown, fileName: string): VercelServicesConfig {
  if (!isRecord(value)) {
    throw new Error(`${fileName} must contain a JSON object.`);
  }

  const services = value.services;

  if (
    services !== undefined &&
    !isRecord(services) &&
    !(
      Array.isArray(services) &&
      services.every(
        (service) =>
          isRecord(service) && typeof service.name === "string" && service.name.trim().length > 0,
      )
    )
  ) {
    throw new Error(`${fileName} services must be a JSON object or named service array.`);
  }

  const routes = value.routes;

  if (routes !== undefined && !Array.isArray(routes)) {
    throw new Error(`${fileName} routes must be an array.`);
  }

  return value as VercelServicesConfig;
}

async function readVercelServicesConfig(
  path: string,
  fileName: string,
): Promise<VercelServicesConfig> {
  try {
    return normalizeVercelServicesConfig(
      JSON.parse(await readFile(path, "utf8")) as unknown,
      fileName,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return {};
    }

    throw error;
  }
}

function resolveConfiguredServicePrefix(input: {
  readonly agent: EnsureVercelOutputConfigAgentInput;
  readonly services: Record<string, VercelServiceConfig>;
}): string {
  const configuredEveService = findConfiguredEveServiceEntry(input.services, input.agent)?.service;
  return resolveServicePrefix(configuredEveService) ?? input.agent.servicePrefix;
}

function assertRootServicesIncludeEve(input: {
  readonly agents: readonly EnsureVercelOutputConfigAgentInput[];
  readonly services: Record<string, VercelServiceConfig>;
}): readonly EnsureVercelOutputConfigAgentResult[] {
  const results: EnsureVercelOutputConfigAgentResult[] = [];

  for (const agent of input.agents) {
    const configuredEveService = findConfiguredEveServiceEntry(input.services, agent)?.service;

    if (configuredEveService === undefined) {
      throw new Error(
        `${VERCEL_JSON_FILE_NAME} already defines services, so withEve cannot add generated eve services through ${VERCEL_OUTPUT_CONFIG_FILE_NAME}. Add the eve service for ${agent.name ?? "the default agent"} to ${VERCEL_JSON_FILE_NAME}, or remove services from ${VERCEL_JSON_FILE_NAME}.`,
      );
    }

    results.push({
      name: agent.name,
      servicePrefix: resolveServicePrefix(configuredEveService) ?? agent.servicePrefix,
    });
  }

  return results;
}

export async function ensureEveVercelOutputConfig(input: {
  readonly agents: readonly EnsureVercelOutputConfigAgentInput[];
  readonly nextRoot: string;
}): Promise<EnsureVercelOutputConfigResult> {
  const { canWriteGeneratedOutput, outputConfigPath, projectRoot } =
    await resolveVercelOutputConfigLocation(input.nextRoot);
  const rootVercelConfig = await readVercelServicesConfig(
    join(projectRoot, VERCEL_JSON_FILE_NAME),
    VERCEL_JSON_FILE_NAME,
  );
  const rootServices = rootVercelConfig.services;

  if (hasServices(rootServices)) {
    return {
      agents: assertRootServicesIncludeEve({
        agents: input.agents,
        services: createServiceConfigRecord(rootServices),
      }),
    };
  }

  const existingConfig = (await readVercelServicesConfig(
    outputConfigPath,
    VERCEL_OUTPUT_CONFIG_FILE_NAME,
  )) as VercelOutputConfig;
  const existingServices = createServiceConfigRecord(existingConfig.services);
  const agentResults = input.agents.map((agent) => ({
    name: agent.name,
    servicePrefix: resolveConfiguredServicePrefix({
      agent,
      services: existingServices,
    }),
  }));

  if (!canWriteGeneratedOutput) {
    return {
      agents: agentResults,
    };
  }

  const services: Record<string, VercelServiceConfig> = {
    ...existingServices,
  };
  const eveRoutes: {
    routeSrc: string;
    serviceName: string;
  }[] = [];

  for (const agent of input.agents) {
    const configuredEveServiceEntry = findConfiguredEveServiceEntry(existingServices, agent);
    const serviceName = configuredEveServiceEntry?.name ?? createEveServiceName(agent.name);
    const routeSrc = createEveServiceRouteSrc(agent.publicRoutePrefix);

    if (configuredEveServiceEntry === undefined) {
      const generatedService = compileEveVercelService({
        agent,
        target: {
          hostOutputDirectory: dirname(outputConfigPath),
          kind: "isolated",
          projectRoot: input.nextRoot,
        },
      });
      await mkdir(generatedService.rootDirectory, { recursive: true });
      const serviceConfig: MutableGeneratedVercelServiceConfig = {
        ...generatedService.service,
        routes: insertEveServiceRequestPathRoute(undefined, routeSrc),
      };

      if (agent.publicRoutePrefix.length > 0) {
        serviceConfig.routePrefix = agent.publicRoutePrefix;
      }

      services[serviceName] = serviceConfig;
    } else {
      services[serviceName] = {
        ...configuredEveServiceEntry.service,
        routes: insertEveServiceRequestPathRoute(
          configuredEveServiceEntry.service.routes,
          routeSrc,
        ),
      };
    }

    eveRoutes.push({
      routeSrc,
      serviceName,
    });
  }

  const { services: _services, ...configWithoutLegacyServices } = existingConfig;
  const vercelConfig: VercelOutputConfig = {
    ...configWithoutLegacyServices,
    routes: insertEveServiceRoutes(existingConfig.routes ?? [], eveRoutes),
    services,
    version: VERCEL_BUILD_OUTPUT_VERSION,
  };

  if (JSON.stringify(existingConfig) !== JSON.stringify(vercelConfig)) {
    await mkdir(dirname(outputConfigPath), { recursive: true });
    await writeFile(outputConfigPath, `${JSON.stringify(vercelConfig, null, 2)}\n`);
  }

  return {
    agents: agentResults,
  };
}
