import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";
import {
  createDockerSandboxBackend,
  createJustBashSandboxBackend,
  createMicrosandboxSandboxBackend,
} from "#execution/sandbox/bindings/local.js";
import { requireSandboxRuntimeCreationContext } from "#execution/sandbox/creation-context.js";
import type { SandboxBackend, SandboxBackendHandle } from "#shared/sandbox-backend.js";
import type { JsonObject } from "#shared/json.js";
import { parseJsonObject } from "#shared/json.js";
import { defineSandboxAdapter, type Sandbox } from "#shared/sandbox-value.js";

export type BuiltinSandboxBackendName = "docker" | "just-bash" | "microsandbox" | "vercel";

interface BackendSandbox {
  readonly appRoot: string;
  readonly backendName: BuiltinSandboxBackendName;
  readonly handle: SandboxBackendHandle;
  readonly templateKey: string | null;
  readonly templateReference?: JsonObject;
}

interface BackendSandboxReference extends JsonObject {
  readonly appRoot: string;
  readonly backendName: BuiltinSandboxBackendName;
  readonly session: JsonObject;
  readonly templateKey: string | null;
  readonly templateReference: JsonObject | null;
}

const adaptBackendSandbox = defineSandboxAdapter<BackendSandbox, BackendSandboxReference>({
  async reference(sandbox) {
    return {
      appRoot: sandbox.appRoot,
      backendName: sandbox.backendName,
      session: parseJsonObject(await sandbox.handle.captureState()),
      templateKey: sandbox.templateKey,
      templateReference: sandbox.templateReference ?? null,
    };
  },
  async restore(reference) {
    const backend = createBuiltinSandboxBackend(reference.backendName);
    const sessionState = parseBackendSessionState(reference.session);
    return await createBackendSandboxHandle({
      appRoot: reference.appRoot,
      backend,
      backendName: reference.backendName,
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

function parseBackendSessionState(session: JsonObject): {
  readonly metadata: Record<string, unknown>;
  readonly sessionKey: string;
} {
  if (
    typeof session.sessionKey !== "string" ||
    session.metadata === null ||
    Array.isArray(session.metadata) ||
    typeof session.metadata !== "object"
  ) {
    throw new TypeError("Invalid persisted built-in sandbox session.");
  }
  return {
    metadata: Object.fromEntries(Object.entries(session.metadata)),
    sessionKey: session.sessionKey,
  };
}

export async function createBuiltinSandbox(input: {
  readonly backend: SandboxBackend;
  readonly backendName: BuiltinSandboxBackendName;
  readonly sessionKey?: string;
  readonly templateKey: string | null;
  readonly templateReference?: JsonObject;
}): Promise<Sandbox> {
  const context = requireSandboxRuntimeCreationContext();
  return adaptBackendSandbox(
    await createBackendSandboxHandle({
      appRoot: context.appRoot,
      backend: input.backend,
      backendName: input.backendName,
      sessionKey: input.sessionKey ?? context.sessionKey,
      signal: context.signal,
      tags: context.tags,
      templateKey: input.templateKey,
      templateReference: input.templateReference,
    }),
  );
}

export function createBuiltinSandboxBackend(
  backendName: BuiltinSandboxBackendName,
): SandboxBackend {
  switch (backendName) {
    case "docker":
      return createDockerSandboxBackend();
    case "just-bash":
      return createJustBashSandboxBackend();
    case "microsandbox":
      return createMicrosandboxSandboxBackend();
    case "vercel":
      return createVercelSandbox();
  }
}

async function createBackendSandboxHandle(input: {
  readonly appRoot: string;
  readonly backend: SandboxBackend;
  readonly backendName: BuiltinSandboxBackendName;
  readonly existingMetadata?: Record<string, unknown>;
  readonly sessionKey: string;
  readonly signal?: AbortSignal;
  readonly tags?: Readonly<Record<string, string>>;
  readonly templateKey: string | null;
  readonly templateReference?: JsonObject;
}): Promise<BackendSandbox> {
  const handle = await input.backend.create({
    existingMetadata: input.existingMetadata,
    runtimeContext: { appRoot: input.appRoot },
    sessionKey: input.sessionKey,
    signal: input.signal,
    tags: input.tags,
    templateKey: input.templateKey,
    templateReference: input.templateReference,
  });
  return {
    appRoot: input.appRoot,
    backendName: input.backendName,
    handle,
    templateKey: input.templateKey,
    ...(input.templateReference === undefined
      ? {}
      : { templateReference: input.templateReference }),
  };
}
