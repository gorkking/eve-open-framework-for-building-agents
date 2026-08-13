import type * as EveBuildEngine from "@eve/build";

import { resolveInstalledPackageInfo } from "#internal/application/package.js";

const BUILD_ENGINE_PACKAGE_NAME = "@eve/build";
const SUPPORTED_BUILD_ENGINE_PROTOCOL = 1;

let buildEnginePromise: Promise<typeof EveBuildEngine> | undefined;

function missingBuildEngineError(): Error {
  const eveVersion = resolveInstalledPackageInfo().version;
  return new Error(
    `This eve command requires the project-local ${BUILD_ENGINE_PACKAGE_NAME} package. ` +
      `Install the matching engine with \`pnpm add --save-dev ${BUILD_ENGINE_PACKAGE_NAME}@${eveVersion}\`.`,
  );
}

function isMissingBuildEngineError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "ERR_MODULE_NOT_FOUND" &&
    error.message.includes(BUILD_ENGINE_PACKAGE_NAME)
  );
}

async function importBuildEngine(): Promise<typeof EveBuildEngine> {
  try {
    return await import("@eve/build");
  } catch (error) {
    if (isMissingBuildEngineError(error)) {
      throw missingBuildEngineError();
    }
    throw error;
  }
}

/** Loads and validates the project-local build engine used by heavy commands. */
export async function loadBuildEngine(): Promise<typeof EveBuildEngine> {
  buildEnginePromise ??= importBuildEngine();
  const buildEngine = await buildEnginePromise;

  if (buildEngine.EVE_BUILD_ENGINE_PROTOCOL !== SUPPORTED_BUILD_ENGINE_PROTOCOL) {
    throw new Error(
      `Incompatible ${BUILD_ENGINE_PACKAGE_NAME} protocol ${String(buildEngine.EVE_BUILD_ENGINE_PROTOCOL)}; ` +
        `eve requires protocol ${SUPPORTED_BUILD_ENGINE_PROTOCOL}. Install matching eve and ${BUILD_ENGINE_PACKAGE_NAME} versions.`,
    );
  }

  return buildEngine;
}
