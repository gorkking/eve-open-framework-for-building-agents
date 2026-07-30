import { createMicrosandboxSandboxEngine } from "#execution/sandbox/bindings/local.js";
import { createBuiltinSandbox } from "#execution/sandbox/builtin-sandbox.js";
import { createBuiltinSandboxTemplate } from "#execution/sandbox/builtin-template.js";
import type { Sandbox } from "#shared/sandbox-value.js";
import type { SandboxTemplate } from "#shared/sandbox-template.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";

export type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";

/**
 * Build-time options for a microsandbox template.
 */
export interface MicrosandboxSandboxTemplateOptions extends MicrosandboxSandboxCreateOptions {
  /**
   * Runs during template prewarm after eve hydrates the managed workspace.
   */
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

/**
 * A build-prewarmed microsandbox base.
 */
export interface MicrosandboxSandboxTemplate extends Omit<SandboxTemplate<undefined>, "create"> {
  create(): Promise<Sandbox>;
}

/**
 * microsandbox creation and build-prewarming.
 */
export const MicrosandboxSandbox = {
  /**
   * Creates the durable microsandbox returned by an authored definition.
   */
  async create(options: MicrosandboxSandboxCreateOptions = {}): Promise<Sandbox> {
    return await createBuiltinSandbox({
      engine: createMicrosandboxSandboxEngine({ createOptions: options }),
      provider: "microsandbox",
      templateKey: null,
    });
  },

  /**
   * Declares a reusable microsandbox base that eve prepares during build.
   */
  template(options: MicrosandboxSandboxTemplateOptions = {}): MicrosandboxSandboxTemplate {
    const { prepare, ...createOptions } = options;
    return createBuiltinSandboxTemplate<undefined>({
      provider: "microsandbox",
      createEngine() {
        return createMicrosandboxSandboxEngine({ createOptions });
      },
      prepare,
      revision: createOptions,
      templateEngine: createMicrosandboxSandboxEngine({ createOptions }),
    }) as MicrosandboxSandboxTemplate;
  },
};
