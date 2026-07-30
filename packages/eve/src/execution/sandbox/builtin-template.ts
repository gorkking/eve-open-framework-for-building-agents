import type { SandboxEngine } from "#shared/sandbox-engine.js";
import { parseJsonValue, type JsonObject } from "#shared/json.js";
import type { Sandbox } from "#shared/sandbox-value.js";
import { defineSandboxTemplate, type SandboxTemplate } from "#shared/sandbox-template.js";
import { requireSandboxTemplateBuildContext } from "#execution/sandbox/creation-context.js";
import {
  createBuiltinSandbox,
  type BuiltinSandboxProvider,
} from "#execution/sandbox/builtin-sandbox.js";
import { writeSandboxSeedFiles } from "#execution/sandbox/bindings/local-workspace-utils.js";

interface BuiltinTemplateReference extends JsonObject {
  readonly provider: JsonObject | null;
  readonly templateKey: string;
}

export interface BuiltinSandboxTemplateOptions {
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
}

export interface BuiltinSandboxTemplate<CreateOptions> extends SandboxTemplate<CreateOptions> {
  create(options?: CreateOptions): Promise<Sandbox>;
  createWithSessionKey(options: CreateOptions, sessionKey: string): Promise<Sandbox>;
}

interface BuiltinTemplateCreateRequest<CreateOptions> {
  readonly options: CreateOptions | undefined;
  readonly sessionKey?: string;
}

export function createBuiltinSandboxTemplate<CreateOptions>(input: {
  readonly createEngine: (options: CreateOptions | undefined) => SandboxEngine;
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
  readonly provider: BuiltinSandboxProvider;
  readonly revision?: unknown;
  readonly templateEngine: SandboxEngine;
}): BuiltinSandboxTemplate<CreateOptions> {
  const internalTemplate = defineSandboxTemplate<
    BuiltinTemplateReference,
    BuiltinTemplateCreateRequest<CreateOptions>
  >({
    revision: parseJsonValue(input.revision ?? null),
    async prewarm({ hydrate }) {
      const context = requireSandboxTemplateBuildContext();
      const result = await input.templateEngine.prepare({
        prepare: async (sandbox) => {
          await hydrate(sandbox);
          await input.prepare?.(sandbox);
        },
        log: context.log,
        context: { appRoot: context.appRoot },
        seedFiles: [],
        templateKey: context.templateKey,
      });
      return {
        provider: result.reference ?? null,
        templateKey: context.templateKey,
      };
    },
    async create({ options: request, reference }) {
      return await createBuiltinSandbox({
        engine: input.createEngine(request.options),
        provider: input.provider,
        sessionKey: request.sessionKey,
        templateKey: reference.templateKey,
        templateReference: reference.provider ?? undefined,
      });
    },
  });
  const createFromReference = internalTemplate.create.bind(internalTemplate);

  return Object.assign(internalTemplate, {
    async create(options?: CreateOptions): Promise<Sandbox> {
      return await createFromReference({ options });
    },
    async createWithSessionKey(options: CreateOptions, sessionKey: string): Promise<Sandbox> {
      return await createFromReference({ options, sessionKey });
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
