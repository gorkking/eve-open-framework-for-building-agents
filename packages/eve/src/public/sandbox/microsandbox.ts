import { createMicrosandboxSandboxBackend } from "#execution/sandbox/bindings/local.js";
import { createBuiltinSandbox } from "#execution/sandbox/backend-sandbox.js";
import { createBuiltinSandboxTemplate } from "#execution/sandbox/builtin-template.js";
import type { Sandbox } from "#shared/sandbox-value.js";
import type { SandboxTemplate } from "#shared/sandbox-template.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";

export type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";

export interface MicrosandboxSandboxTemplateOptions extends MicrosandboxSandboxCreateOptions {
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

export interface MicrosandboxSandboxTemplate extends Omit<SandboxTemplate<undefined>, "create"> {
  create(): Promise<Sandbox>;
}

/**
 * microsandbox creation and build-prewarming.
 */
export const MicrosandboxSandbox = {
  async create(options: MicrosandboxSandboxCreateOptions = {}): Promise<Sandbox> {
    return await createBuiltinSandbox({
      backend: createMicrosandboxSandboxBackend({ createOptions: options }),
      backendName: "microsandbox",
      templateKey: null,
    });
  },

  template(options: MicrosandboxSandboxTemplateOptions = {}): MicrosandboxSandboxTemplate {
    const { prepare, ...createOptions } = options;
    return createBuiltinSandboxTemplate<undefined>({
      backendName: "microsandbox",
      createBackend() {
        return createMicrosandboxSandboxBackend({ createOptions });
      },
      prepare,
      revision: createOptions,
      templateBackend: createMicrosandboxSandboxBackend({ createOptions }),
    }) as MicrosandboxSandboxTemplate;
  },
};
