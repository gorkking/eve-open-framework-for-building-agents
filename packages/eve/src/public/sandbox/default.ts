import {
  createBuiltinSandbox,
  createBuiltinSandboxBackend,
  type BuiltinSandboxBackendName,
} from "#execution/sandbox/backend-sandbox.js";
import { requireSandboxTemplateBuildContext } from "#execution/sandbox/creation-context.js";
import {
  createDefaultSandboxBackend,
  type DefaultSandboxOptions,
} from "#execution/sandbox/default-backend.js";
import type { SandboxBackend } from "#shared/sandbox-backend.js";
import type { Sandbox } from "#shared/sandbox-value.js";
import { defineSandboxTemplate, type SandboxTemplate } from "#shared/sandbox-template.js";
import type { JsonObject } from "#shared/json.js";

export type { DefaultSandboxOptions };

export interface DefaultSandboxTemplateOptions {
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

export interface DefaultSandboxTemplate extends Omit<SandboxTemplate<undefined>, "create"> {
  create(): Promise<Sandbox>;
}

interface DefaultTemplateReference extends JsonObject {
  readonly backendName: BuiltinSandboxBackendName;
  readonly provider: JsonObject | null;
  readonly templateKey: string;
}

/**
 * Availability-aware sandbox creation used by eve's framework default.
 */
export const DefaultSandbox = {
  /**
   * Creates a durable sandbox using the best provider available at runtime.
   */
  async create(options?: DefaultSandboxOptions): Promise<Sandbox> {
    const backend = createDefaultSandboxBackend(options);
    return await createBuiltinSandbox({
      backend,
      backendName: expectBuiltinBackendName(backend),
      templateKey: null,
    });
  },

  /**
   * Declares a build-prewarmed base using the provider available at build
   * time. The frozen reference records that provider for runtime creation.
   */
  template(options: DefaultSandboxTemplateOptions = {}): DefaultSandboxTemplate {
    return defineSandboxTemplate<DefaultTemplateReference, undefined>({
      async prewarm({ hydrate }) {
        const context = requireSandboxTemplateBuildContext();
        const backend = createDefaultSandboxBackend();
        const backendName = expectBuiltinBackendName(backend);
        const result = await backend.prewarm({
          bootstrap: async ({ use }) => {
            const sandbox = (await use()) as Sandbox;
            await hydrate(sandbox);
            await options.prepare?.(sandbox);
          },
          log: context.log,
          runtimeContext: { appRoot: context.appRoot },
          seedFiles: [],
          templateKey: context.templateKey,
        });
        return {
          backendName,
          provider: result.templateReference ?? null,
          templateKey: context.templateKey,
        };
      },
      async create({ reference }) {
        const backend = createBuiltinSandboxBackend(reference.backendName);
        return await createBuiltinSandbox({
          backend,
          backendName: reference.backendName,
          templateKey: reference.templateKey,
          templateReference: reference.provider ?? undefined,
        });
      },
    }) as DefaultSandboxTemplate;
  },
};

function expectBuiltinBackendName(backend: SandboxBackend): BuiltinSandboxBackendName {
  if (
    backend.name === "docker" ||
    backend.name === "just-bash" ||
    backend.name === "microsandbox" ||
    backend.name === "vercel"
  ) {
    return backend.name;
  }
  throw new Error(`DefaultSandbox selected unsupported backend "${backend.name}".`);
}
