import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";
import { createBuiltinSandbox } from "#execution/sandbox/builtin-sandbox.js";
import { createBuiltinSandboxTemplate } from "#execution/sandbox/builtin-template.js";
import type { Sandbox } from "#shared/sandbox-value.js";
import type { SandboxTemplate } from "#shared/sandbox-template.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";
import { parseJsonObject } from "#shared/json.js";

export type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";

/**
 * Build-time options for a Vercel Sandbox template.
 */
export type VercelSandboxTemplateOptions = VercelSandboxCreateOptions & {
  /**
   * Runs during template prewarm after eve hydrates the managed workspace.
   */
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
};

/**
 * Options for intentionally sharing a named Vercel Sandbox.
 */
export type VercelSandboxGetOrCreateOptions = VercelSandboxCreateOptions & {
  readonly name: string;
};

/**
 * A build-prewarmed Vercel Sandbox base.
 */
export interface VercelSandboxTemplate extends Omit<
  SandboxTemplate<VercelSandboxCreateOptions>,
  "create"
> {
  create(options?: VercelSandboxCreateOptions): Promise<Sandbox>;
  getOrCreate(options: VercelSandboxGetOrCreateOptions): Promise<Sandbox>;
}

/**
 * Vercel Sandbox creation and build-prewarming.
 */
export const VercelSandbox = {
  /**
   * Creates the durable Vercel Sandbox returned by an authored definition.
   */
  async create(options: VercelSandboxCreateOptions = {}): Promise<Sandbox> {
    return await createBuiltinSandbox({
      engine: createVercelSandbox({ createOptions: options }),
      provider: "vercel",
      templateKey: null,
    });
  },

  /**
   * Declares a reusable Vercel Sandbox base that eve prepares during build.
   */
  template(options: VercelSandboxTemplateOptions = {}): VercelSandboxTemplate {
    const { prepare, ...templateCreateOptions } = options;
    const template = createBuiltinSandboxTemplate<VercelSandboxCreateOptions>({
      provider: "vercel",
      createEngine(createOptions) {
        return createVercelSandbox({
          createOptions: {
            ...templateCreateOptions,
            ...createOptions,
          } as VercelSandboxCreateOptions,
        });
      },
      prepare,
      revision: createVercelTemplateOptionsRevision(templateCreateOptions),
      templateEngine: createVercelSandbox({ createOptions: templateCreateOptions }),
    });

    return Object.assign(template, {
      async getOrCreate({
        name,
        ...createOptions
      }: VercelSandboxGetOrCreateOptions): Promise<Sandbox> {
        return await template.createWithSessionKey(createOptions, name);
      },
    }) as VercelSandboxTemplate;
  },
};

function createVercelTemplateOptionsRevision(options: VercelSandboxCreateOptions) {
  return parseJsonObject(options);
}
