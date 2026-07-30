import type { SandboxBackend } from "#shared/sandbox-backend.js";
import { parseJsonValue, type JsonObject } from "#shared/json.js";
import type { Sandbox } from "#shared/sandbox-value.js";
import { defineSandboxTemplate, type SandboxTemplate } from "#shared/sandbox-template.js";
import { requireSandboxTemplateBuildContext } from "#execution/sandbox/creation-context.js";
import {
  createBuiltinSandbox,
  type BuiltinSandboxBackendName,
} from "#execution/sandbox/backend-sandbox.js";
import { writeSandboxSeedFiles } from "#execution/sandbox/bindings/local-backend-utils.js";

interface BuiltinTemplateReference extends JsonObject {
  readonly provider: JsonObject | null;
  readonly templateKey: string;
}

export interface BuiltinSandboxTemplateOptions {
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

export function createBuiltinSandboxTemplate<CreateOptions>(input: {
  readonly backendName: BuiltinSandboxBackendName;
  readonly createBackend: (options: CreateOptions | undefined) => SandboxBackend;
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
  readonly revision?: unknown;
  readonly sessionKey?: (options: CreateOptions | undefined) => string | undefined;
  readonly templateBackend: SandboxBackend;
}): SandboxTemplate<CreateOptions> {
  return defineSandboxTemplate<BuiltinTemplateReference, CreateOptions>({
    revision: parseJsonValue(input.revision ?? null),
    async prewarm({ hydrate }) {
      const context = requireSandboxTemplateBuildContext();
      const result = await input.templateBackend.prewarm({
        bootstrap: async ({ use }) => {
          const sandbox = (await use()) as Sandbox;
          await hydrate(sandbox);
          await input.prepare?.(sandbox);
        },
        log: context.log,
        runtimeContext: { appRoot: context.appRoot },
        seedFiles: [],
        templateKey: context.templateKey,
      });
      return {
        provider: result.templateReference ?? null,
        templateKey: context.templateKey,
      };
    },
    async create({ options, reference }) {
      return await createBuiltinSandbox({
        backend: input.createBackend(options),
        backendName: input.backendName,
        sessionKey: input.sessionKey?.(options),
        templateKey: reference.templateKey,
        templateReference: reference.provider ?? undefined,
      });
    },
  });
}

export function createSandboxHydrator(
  seedFiles: ReadonlyArray<{ readonly path: string; readonly content: string | Buffer }>,
): (sandbox: Sandbox) => Promise<void> {
  return async (sandbox) => {
    await writeSandboxSeedFiles(sandbox, seedFiles);
  };
}
