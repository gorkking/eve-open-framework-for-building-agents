import {
  createMicrosandboxHandle,
  prewarmMicrosandboxTemplate,
} from "#execution/sandbox/bindings/microsandbox-lifecycle.js";
import { enrichMicrosandboxError } from "#execution/sandbox/bindings/microsandbox-create.js";
import {
  microsandboxOptionsForHash,
  resolveMicrosandboxOptions,
} from "#execution/sandbox/bindings/microsandbox-options.js";
import { createStableHash } from "#execution/sandbox/bindings/microsandbox-runtime.js";
import type {
  SandboxEngine,
  SandboxEngineCreateInput,
  SandboxEngineHandle,
  SandboxEnginePrepareInput,
  SandboxEnginePrepareResult,
} from "#shared/sandbox-engine.js";
import type { MicrosandboxSandboxCreateOptions } from "#public/sandbox/microsandbox-sandbox.js";
import { parseJsonObject } from "#shared/json.js";

export { pruneMicrosandboxTemplates } from "#execution/sandbox/bindings/microsandbox-templates.js";

/**
 * Stable provider name. Participates in template/session key derivation
 * and persisted reconnect state.
 */
export const MICROSANDBOX_PROVIDER = "microsandbox";

/**
 * Construction input for the internal microsandbox bridge behind
 * `MicrosandboxSandbox`.
 */
export interface CreateMicrosandboxSandboxEngineInput {
  readonly createOptions?: MicrosandboxSandboxCreateOptions;
}

/**
 * Creates the microsandbox sandbox provider: lightweight local VMs with
 * snapshot-backed templates, running each command as the
 * `vercel-sandbox` user for parity with hosted Vercel Sandbox.
 */
export function createMicrosandboxSandboxEngine(
  input: CreateMicrosandboxSandboxEngineInput = {},
): SandboxEngine {
  const options = resolveMicrosandboxOptions(input.createOptions);
  const configuration = parseJsonObject(input.createOptions ?? {});
  const optionsHash = createStableHash(JSON.stringify(microsandboxOptionsForHash(options))).slice(
    0,
    20,
  );

  return {
    provider: MICROSANDBOX_PROVIDER,
    async prepare(prewarmInput: SandboxEnginePrepareInput): Promise<SandboxEnginePrepareResult> {
      try {
        return await prewarmMicrosandboxTemplate({
          provider: MICROSANDBOX_PROVIDER,
          options,
          optionsHash,
          prewarmInput,
        });
      } catch (error) {
        throw enrichMicrosandboxError({
          context: `Failed to prewarm microsandbox template "${prewarmInput.templateKey}"`,
          error,
        });
      }
    },
    async create(createInput: SandboxEngineCreateInput): Promise<SandboxEngineHandle> {
      return await createMicrosandboxHandle({
        provider: MICROSANDBOX_PROVIDER,
        configuration,
        createInput,
        options,
        optionsHash,
      });
    },
  };
}
