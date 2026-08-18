import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { normalizeAgentDefinition } from "#internal/authored-definition/core.js";
import { loadAuthoredModuleNamespace } from "#internal/authored-module-loader.js";
import type { AgentDefinition } from "#public/definitions/agent.js";
import type { ExactDefinition } from "#public/definitions/exact.js";

const EMBEDDED_AGENT_BRAND = Symbol.for("eve.experimental.embedded-agent");
const EMBEDDED_AGENT_RESOURCES = Symbol.for("eve.experimental.embedded-agent.resources");

export interface EmbeddedAgentResources {
  readonly instructions: string;
  readonly channels?: unknown;
  readonly schedules?: unknown;
  readonly sandbox?: unknown;
  readonly tools?: unknown;
}

export interface EmbeddedAgentDefinition {
  readonly agent: AgentDefinition;
  readonly resources: EmbeddedAgentResources;
}

export type DefinedEmbeddedAgent<TAgent extends AgentDefinition = AgentDefinition> = TAgent & {
  readonly [EMBEDDED_AGENT_BRAND]: true;
};

export interface LoadedEmbeddedAgentEntrypoint {
  readonly appRoot: string;
  readonly definition: AgentDefinition;
  readonly entrypointPath: string;
  readonly resources: Pick<EmbeddedAgentResources, "instructions">;
  readonly moduleNamespace: Readonly<Record<string, unknown>>;
}

export function defineEmbeddedAgent<TDefinition extends EmbeddedAgentDefinition>(
  definition: ExactDefinition<TDefinition, EmbeddedAgentDefinition> & {
    readonly agent: ExactDefinition<TDefinition["agent"], AgentDefinition>;
    readonly resources: ExactDefinition<TDefinition["resources"], EmbeddedAgentResources>;
  },
): DefinedEmbeddedAgent<TDefinition["agent"]>;
export function defineEmbeddedAgent(
  definition: EmbeddedAgentDefinition,
): DefinedEmbeddedAgent<AgentDefinition> {
  if (!isPlainObject(definition)) {
    throw new Error("Expected defineEmbeddedAgent(...) to receive an object definition.");
  }
  assertOnlyFields(definition, ["agent", "resources"], "definition");
  if (!isPlainObject(definition.agent)) {
    throw new Error('Expected defineEmbeddedAgent(...) to receive an object "agent" field.');
  }
  if (!isPlainObject(definition.resources)) {
    throw new Error('Expected defineEmbeddedAgent(...) to receive an object "resources" field.');
  }
  assertOnlyFields(
    definition.resources,
    ["instructions", "channels", "schedules", "sandbox", "tools"],
    "resources",
  );
  if (typeof definition.resources.instructions !== "string") {
    throw new Error(
      'Expected defineEmbeddedAgent(...) to receive a string "resources.instructions" field.',
    );
  }

  for (const field of ["channels", "schedules", "sandbox", "tools"] as const) {
    if (Object.hasOwn(definition.resources, field)) {
      throw new Error(
        `Embedded agent resource "${field}" is not supported by this experimental prototype.`,
      );
    }
  }

  const agentDefinition = { ...definition.agent };
  const resources = Object.freeze({ instructions: definition.resources.instructions });
  Object.defineProperties(agentDefinition, {
    [EMBEDDED_AGENT_BRAND]: { value: true },
    [EMBEDDED_AGENT_RESOURCES]: { value: resources },
  });
  return agentDefinition as DefinedEmbeddedAgent<AgentDefinition>;
}

export async function loadEmbeddedAgentEntrypoint(input: {
  readonly appRoot: string;
  readonly entrypoint: string;
}): Promise<LoadedEmbeddedAgentEntrypoint> {
  const requestedAppRoot = resolve(input.appRoot);
  const requestedEntrypointPath = resolve(requestedAppRoot, input.entrypoint);
  const requestedRelativeEntrypoint = relative(requestedAppRoot, requestedEntrypointPath);
  if (
    requestedRelativeEntrypoint === "" ||
    requestedRelativeEntrypoint.startsWith("..") ||
    isAbsolute(requestedRelativeEntrypoint)
  ) {
    throw embeddedEntrypointError(
      input.entrypoint,
      `The entrypoint must resolve to a file under the application root "${requestedAppRoot}".`,
    );
  }

  const appRoot = await resolveRealPath(requestedAppRoot, input.entrypoint, "application root");
  const entrypointPath = await resolveRealPath(
    requestedEntrypointPath,
    input.entrypoint,
    "entrypoint",
  );
  const relativeEntrypoint = relative(appRoot, entrypointPath);
  if (
    relativeEntrypoint === "" ||
    relativeEntrypoint.startsWith("..") ||
    isAbsolute(relativeEntrypoint)
  ) {
    throw embeddedEntrypointError(
      input.entrypoint,
      `The entrypoint must resolve to a file under the application root "${appRoot}".`,
    );
  }

  let moduleNamespace: Record<string, unknown>;
  try {
    moduleNamespace = await loadAuthoredModuleNamespace(entrypointPath);
  } catch (error) {
    throw embeddedEntrypointError(input.entrypoint, "Failed to load the entrypoint.", error);
  }

  if (!Object.hasOwn(moduleNamespace, "default")) {
    throw embeddedEntrypointError(input.entrypoint, "The entrypoint must have a default export.");
  }

  const definition = moduleNamespace.default;
  const resources = isPlainObject(definition)
    ? Reflect.get(definition, EMBEDDED_AGENT_RESOURCES)
    : undefined;
  if (
    !isPlainObject(definition) ||
    Reflect.get(definition, EMBEDDED_AGENT_BRAND) !== true ||
    !isPlainObject(resources) ||
    typeof resources.instructions !== "string"
  ) {
    throw embeddedEntrypointError(
      input.entrypoint,
      "The default export must be produced by defineEmbeddedAgent(...).",
    );
  }

  const message = `Expected the embedded agent default export from "${input.entrypoint}" to match the public eve agent shape.`;
  let normalizedDefinition: AgentDefinition;
  try {
    normalizedDefinition = normalizeAgentDefinition(definition, message) as AgentDefinition;
  } catch (error) {
    throw embeddedEntrypointError(input.entrypoint, "The default export is malformed.", error);
  }

  return {
    appRoot,
    definition: normalizedDefinition,
    entrypointPath,
    resources: { instructions: resources.instructions },
    moduleNamespace,
  };
}

function isPlainObject(value: unknown): value is Record<PropertyKey, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyFields(
  value: Record<PropertyKey, unknown>,
  supportedFields: readonly string[],
  kind: string,
): void {
  const unknownField = Object.keys(value).find((field) => !supportedFields.includes(field));
  if (unknownField !== undefined) {
    throw new Error(`Embedded agent ${kind} field "${unknownField}" is not recognized.`);
  }
}

async function resolveRealPath(path: string, entrypoint: string, kind: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    throw embeddedEntrypointError(entrypoint, `Failed to resolve the ${kind} at "${path}".`, error);
  }
}

function embeddedEntrypointError(entrypoint: string, message: string, cause?: unknown): Error {
  return new Error(`Invalid embedded agent entrypoint "${entrypoint}": ${message}`, { cause });
}
