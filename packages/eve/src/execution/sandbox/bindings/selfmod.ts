import { join } from "node:path";

import {
  createBashSandbox,
  createJustBashHandle,
} from "#execution/sandbox/bindings/just-bash-runtime.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import type { SandboxBackend } from "#public/definitions/sandbox-backend.js";
import { SELFMOD_SANDBOX_BACKEND_NAME } from "#shared/selfmod-definition.js";

/** Creates the internal just-bash backend mounted over the live authored agent root. */
export function createSelfModifyingSandboxBackend(): SandboxBackend {
  return {
    name: SELFMOD_SANDBOX_BACKEND_NAME,
    async prewarm() {
      return { reused: true };
    },
    async create(input) {
      const agentRoot = input.runtimeContext.agentRoot;
      if (agentRoot === undefined) {
        throw new Error("The selfmod sandbox requires the owning agent root.");
      }
      const stateRoot = join(
        resolveSandboxCacheDirectory(input.runtimeContext.appRoot),
        "selfmod",
        input.sessionKey,
      );
      const sandbox = await createBashSandbox({
        appRoot: input.runtimeContext.appRoot,
        autoInstall: true,
        rootPath: stateRoot,
        sessionKey: input.sessionKey,
        workspaceRootPath: agentRoot,
      });
      return createJustBashHandle(sandbox, SELFMOD_SANDBOX_BACKEND_NAME);
    },
  };
}
