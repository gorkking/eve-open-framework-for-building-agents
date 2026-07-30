import {
  createBuiltinSandbox,
  createBuiltinSandboxEngine,
  type BuiltinSandboxProvider,
} from "#execution/sandbox/builtin-sandbox.js";
import { requireSandboxTemplateBuildContext } from "#execution/sandbox/creation-context.js";
import {
  createDefaultSandboxEngine,
  type DefaultSandboxOptions,
} from "#execution/sandbox/default-engine.js";
import type { SandboxEngine } from "#shared/sandbox-engine.js";
import type { Sandbox } from "#shared/sandbox-value.js";
import { defineSandboxTemplate, type SandboxTemplate } from "#shared/sandbox-template.js";
import type { JsonObject } from "#shared/json.js";

export type { DefaultSandboxOptions };

/**
 * Build-time options for eve's availability-aware default template.
 */
export interface DefaultSandboxTemplateOptions {
  /**
   * Runs during template prewarm after eve hydrates the managed workspace.
   */
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

/**
 * A build-prewarmed base owned by the provider selected during build.
 */
export interface DefaultSandboxTemplate extends Omit<SandboxTemplate<undefined>, "create"> {
  create(): Promise<Sandbox>;
}

interface DefaultTemplateReference extends JsonObject {
  readonly provider: BuiltinSandboxProvider;
  readonly providerReference: JsonObject | null;
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
    const engine = createDefaultSandboxEngine(options);
    return await createBuiltinSandbox({
      engine,
      provider: expectBuiltinProvider(engine),
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
        const engine = createDefaultSandboxEngine();
        const provider = expectBuiltinProvider(engine);
        const result = await engine.prepare({
          prepare: async (sandbox) => {
            await hydrate(sandbox);
            await options.prepare?.(sandbox);
          },
          log: context.log,
          context: { appRoot: context.appRoot },
          seedFiles: [],
          templateKey: context.templateKey,
        });
        return {
          provider,
          providerReference: result.reference ?? null,
          templateKey: context.templateKey,
        };
      },
      async create({ reference }) {
        const engine = createBuiltinSandboxEngine(reference.provider);
        return await createBuiltinSandbox({
          engine,
          provider: reference.provider,
          templateKey: reference.templateKey,
          templateReference: reference.providerReference ?? undefined,
        });
      },
    }) as DefaultSandboxTemplate;
  },
};

function expectBuiltinProvider(engine: SandboxEngine): BuiltinSandboxProvider {
  if (
    engine.provider === "docker" ||
    engine.provider === "just-bash" ||
    engine.provider === "microsandbox" ||
    engine.provider === "vercel"
  ) {
    return engine.provider;
  }
  throw new Error(`DefaultSandbox selected unsupported provider "${engine.provider}".`);
}
