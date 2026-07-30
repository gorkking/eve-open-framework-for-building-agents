import { createDockerSandboxBackend } from "#execution/sandbox/bindings/local.js";
import { createBuiltinSandbox } from "#execution/sandbox/backend-sandbox.js";
import { createBuiltinSandboxTemplate } from "#execution/sandbox/builtin-template.js";
import type { Sandbox } from "#shared/sandbox-value.js";
import type { SandboxTemplate } from "#shared/sandbox-template.js";
import type { DockerSandboxCreateOptions } from "#public/sandbox/docker-sandbox.js";

export type {
  DockerSandboxCreateOptions,
  DockerSandboxNetworkPolicy,
  DockerSandboxPullPolicy,
} from "#public/sandbox/docker-sandbox.js";

/**
 * Build-time options for a Docker Sandbox template.
 */
export interface DockerSandboxTemplateOptions extends DockerSandboxCreateOptions {
  /**
   * Runs during template prewarm after eve hydrates the managed workspace.
   */
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

/**
 * A build-prewarmed Docker Sandbox base.
 */
export interface DockerSandboxTemplate extends Omit<SandboxTemplate<undefined>, "create"> {
  create(): Promise<Sandbox>;
}

/**
 * Docker Sandbox creation and build-prewarming.
 */
export const DockerSandbox = {
  /**
   * Creates the durable Docker Sandbox returned by an authored definition.
   */
  async create(options: DockerSandboxCreateOptions = {}): Promise<Sandbox> {
    return await createBuiltinSandbox({
      backend: createDockerSandboxBackend({ createOptions: options }),
      backendName: "docker",
      templateKey: null,
    });
  },

  /**
   * Declares a reusable Docker base that eve prepares during build.
   */
  template(options: DockerSandboxTemplateOptions = {}): DockerSandboxTemplate {
    const { prepare, ...createOptions } = options;
    return createBuiltinSandboxTemplate<undefined>({
      backendName: "docker",
      createBackend() {
        return createDockerSandboxBackend({ createOptions });
      },
      prepare,
      revision: createOptions,
      templateBackend: createDockerSandboxBackend({ createOptions }),
    }) as DockerSandboxTemplate;
  },
};
