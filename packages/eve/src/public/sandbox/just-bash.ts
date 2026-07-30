import { createJustBashSandboxBackend } from "#execution/sandbox/bindings/local.js";
import { createBuiltinSandbox } from "#execution/sandbox/backend-sandbox.js";
import { createBuiltinSandboxTemplate } from "#execution/sandbox/builtin-template.js";
import type { Sandbox } from "#shared/sandbox-value.js";
import type { SandboxTemplate } from "#shared/sandbox-template.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";

export type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";

export interface JustBashSandboxTemplateOptions extends JustBashSandboxCreateOptions {
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

export interface JustBashSandboxTemplate extends Omit<SandboxTemplate<undefined>, "create"> {
  create(): Promise<Sandbox>;
}

/**
 * just-bash sandbox creation and build-prewarming.
 */
export const JustBashSandbox = {
  async create(options: JustBashSandboxCreateOptions = {}): Promise<Sandbox> {
    return await createBuiltinSandbox({
      backend: createJustBashSandboxBackend({ createOptions: options }),
      backendName: "just-bash",
      templateKey: null,
    });
  },

  template(options: JustBashSandboxTemplateOptions = {}): JustBashSandboxTemplate {
    const { prepare, ...createOptions } = options;
    return createBuiltinSandboxTemplate<undefined>({
      backendName: "just-bash",
      createBackend() {
        return createJustBashSandboxBackend({ createOptions });
      },
      prepare,
      revision: createOptions,
      templateBackend: createJustBashSandboxBackend({ createOptions }),
    }) as JustBashSandboxTemplate;
  },
};
