import { createJustBashSandboxEngine } from "#execution/sandbox/bindings/local.js";
import { createBuiltinSandbox } from "#execution/sandbox/builtin-sandbox.js";
import { createBuiltinSandboxTemplate } from "#execution/sandbox/builtin-template.js";
import type { Sandbox } from "#shared/sandbox-value.js";
import type { SandboxTemplate } from "#shared/sandbox-template.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";

export type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";

/**
 * Build-time options for a just-bash template.
 */
export interface JustBashSandboxTemplateOptions extends JustBashSandboxCreateOptions {
  /**
   * Runs during template prewarm after eve hydrates the managed workspace.
   */
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

/**
 * A build-prewarmed just-bash filesystem base.
 */
export interface JustBashSandboxTemplate extends Omit<SandboxTemplate<undefined>, "create"> {
  create(): Promise<Sandbox>;
}

/**
 * just-bash sandbox creation and build-prewarming.
 */
export const JustBashSandbox = {
  /**
   * Creates the durable just-bash sandbox returned by an authored definition.
   */
  async create(options: JustBashSandboxCreateOptions = {}): Promise<Sandbox> {
    return await createBuiltinSandbox({
      engine: createJustBashSandboxEngine({ createOptions: options }),
      provider: "just-bash",
      templateKey: null,
    });
  },

  /**
   * Declares a reusable just-bash base that eve prepares during build.
   */
  template(options: JustBashSandboxTemplateOptions = {}): JustBashSandboxTemplate {
    const { prepare, ...createOptions } = options;
    return createBuiltinSandboxTemplate<undefined>({
      provider: "just-bash",
      createEngine() {
        return createJustBashSandboxEngine({ createOptions });
      },
      prepare,
      revision: createOptions,
      templateEngine: createJustBashSandboxEngine({ createOptions }),
    }) as JustBashSandboxTemplate;
  },
};
