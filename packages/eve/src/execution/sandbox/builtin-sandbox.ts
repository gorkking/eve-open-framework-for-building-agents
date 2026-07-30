import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";
import {
  createDockerSandboxEngine,
  createJustBashSandboxEngine,
  createMicrosandboxSandboxEngine,
} from "#execution/sandbox/bindings/local.js";
import { requireSandboxRuntimeCreationContext } from "#execution/sandbox/creation-context.js";
import type { SandboxEngine, SandboxEngineHandle } from "#shared/sandbox-engine.js";
import type { JsonObject } from "#shared/json.js";
import { parseJsonObject } from "#shared/json.js";
import { defineSandboxAdapter, type Sandbox } from "#shared/sandbox-value.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";

export type BuiltinSandboxProvider = "docker" | "just-bash" | "microsandbox" | "vercel";

interface BuiltinSandboxHandle {
  readonly appRoot: string;
  readonly handle: SandboxEngineHandle;
  readonly provider: BuiltinSandboxProvider;
  readonly templateKey: string | null;
  readonly templateReference?: JsonObject;
}

interface BuiltinSandboxReference extends JsonObject {
  readonly appRoot: string;
  readonly provider: BuiltinSandboxProvider;
  readonly session: JsonObject;
  readonly templateKey: string | null;
  readonly templateReference: JsonObject | null;
}

const adaptBuiltinSandbox = {
  docker: createBuiltinSandboxAdapter("docker"),
  "just-bash": createBuiltinSandboxAdapter("just-bash"),
  microsandbox: createBuiltinSandboxAdapter("microsandbox"),
  vercel: createBuiltinSandboxAdapter("vercel"),
} satisfies Record<BuiltinSandboxProvider, (sandbox: BuiltinSandboxHandle) => Sandbox>;

function createBuiltinSandboxAdapter(
  provider: BuiltinSandboxProvider,
): (sandbox: BuiltinSandboxHandle) => Sandbox {
  return defineSandboxAdapter<BuiltinSandboxHandle, BuiltinSandboxReference>({
    type: `eve/${provider}-sandbox`,
    async reference(sandbox) {
      if (sandbox.provider !== provider) {
        throw new TypeError("Built-in sandbox provider does not match its durable adapter.");
      }
      return {
        appRoot: sandbox.appRoot,
        provider,
        session: parseJsonObject(await sandbox.handle.captureState()),
        templateKey: sandbox.templateKey,
        templateReference: sandbox.templateReference ?? null,
      };
    },
    async restore(reference) {
      const sessionState = parseBuiltinSandboxState(reference.session);
      if (reference.provider !== provider || sessionState.provider !== provider) {
        throw new TypeError("Persisted built-in sandbox provider does not match its adapter.");
      }
      const engine = createBuiltinSandboxEngine(provider, sessionState.configuration);
      return await createBuiltinSandboxHandle({
        appRoot: reference.appRoot,
        engine,
        provider,
        existingMetadata: sessionState.metadata,
        sessionKey: sessionState.sessionKey,
        templateKey: reference.templateKey,
        templateReference: reference.templateReference ?? undefined,
      });
    },
    session(sandbox) {
      return sandbox.handle.session;
    },
    async shutdown(sandbox) {
      await sandbox.handle.shutdown();
    },
  });
}

function parseBuiltinSandboxState(session: JsonObject): {
  readonly configuration: JsonObject;
  readonly metadata: JsonObject;
  readonly provider: string;
  readonly sessionKey: string;
} {
  if (
    typeof session.sessionKey !== "string" ||
    typeof session.provider !== "string" ||
    session.configuration === null ||
    Array.isArray(session.configuration) ||
    typeof session.configuration !== "object" ||
    session.metadata === null ||
    Array.isArray(session.metadata) ||
    typeof session.metadata !== "object"
  ) {
    throw new TypeError("Invalid persisted built-in sandbox session.");
  }
  return {
    configuration: parseJsonObject(session.configuration),
    metadata: parseJsonObject(session.metadata),
    provider: session.provider,
    sessionKey: session.sessionKey,
  };
}

export async function createBuiltinSandbox(input: {
  readonly engine: SandboxEngine;
  readonly provider: BuiltinSandboxProvider;
  readonly sessionKey?: string;
  readonly templateKey: string | null;
  readonly templateReference?: JsonObject;
}): Promise<Sandbox> {
  const context = requireSandboxRuntimeCreationContext();
  return adaptBuiltinSandbox[input.provider](
    await createBuiltinSandboxHandle({
      appRoot: context.appRoot,
      engine: input.engine,
      provider: input.provider,
      sessionKey: input.sessionKey ?? context.sessionKey,
      signal: context.signal,
      tags: context.tags,
      templateKey: input.templateKey,
      templateReference: input.templateReference,
    }),
  );
}

export function createBuiltinSandboxEngine(
  provider: BuiltinSandboxProvider,
  configuration: JsonObject = {},
): SandboxEngine {
  switch (provider) {
    case "docker":
      return createDockerSandboxEngine({
        createOptions: configuration as DockerSandboxCreateOptions,
      });
    case "just-bash":
      return createJustBashSandboxEngine({
        createOptions: configuration as JustBashSandboxCreateOptions,
      });
    case "microsandbox":
      return createMicrosandboxSandboxEngine({
        createOptions: configuration as MicrosandboxSandboxCreateOptions,
      });
    case "vercel":
      return createVercelSandbox({
        createOptions: configuration as VercelSandboxCreateOptions,
      });
  }
}

async function createBuiltinSandboxHandle(input: {
  readonly appRoot: string;
  readonly engine: SandboxEngine;
  readonly provider: BuiltinSandboxProvider;
  readonly existingMetadata?: JsonObject;
  readonly sessionKey: string;
  readonly signal?: AbortSignal;
  readonly tags?: Readonly<Record<string, string>>;
  readonly templateKey: string | null;
  readonly templateReference?: JsonObject;
}): Promise<BuiltinSandboxHandle> {
  if (input.engine.provider !== input.provider) {
    throw new TypeError(
      `Built-in sandbox engine "${input.engine.provider}" cannot create provider "${input.provider}".`,
    );
  }
  const handle = await input.engine.create({
    existingMetadata: input.existingMetadata,
    context: { appRoot: input.appRoot },
    sessionKey: input.sessionKey,
    signal: input.signal,
    tags: input.tags,
    templateKey: input.templateKey,
    templateReference: input.templateReference,
  });
  return {
    appRoot: input.appRoot,
    handle,
    provider: input.provider,
    templateKey: input.templateKey,
    ...(input.templateReference === undefined
      ? {}
      : { templateReference: input.templateReference }),
  };
}
