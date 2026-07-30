import { randomUUID } from "node:crypto";
import { type Dirent } from "node:fs";
import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  copyDirectoryAtomically,
  createFileBackedInternalSandboxSession,
  pathExists,
  resolveLocalProviderSessionRootPath,
  resolveLocalProviderTemplateRootPath,
  resolveLocalProviderTemplatesDirectory,
  touchDirectory,
  writeSandboxSeedFiles,
} from "#execution/sandbox/bindings/local-workspace-utils.js";
import {
  createBashSandbox,
  createJustBashHandle,
  justBashSetNetworkPolicyUnsupported,
} from "#execution/sandbox/bindings/just-bash-runtime.js";
import {
  LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS,
  LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT,
  selectStaleTemplateEntries,
} from "#execution/sandbox/bindings/local-template-prune.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import type {
  SandboxEngine,
  SandboxEngineCreateInput,
  SandboxEngineHandle,
  SandboxEnginePrepareInput,
  SandboxEnginePrepareResult,
} from "#shared/sandbox-engine.js";
import {
  SandboxResourceUnavailableError,
  SandboxTemplateUnavailableError,
} from "#shared/sandbox-engine.js";
import { parseJsonObject } from "#shared/json.js";
import type { JustBashSandboxCreateOptions } from "#public/sandbox/just-bash-sandbox.js";

const JUST_BASH_CACHE_DIRECTORY_NAME = "just-bash";

/**
 * Stable provider name. Participates in template/session key derivation
 * and persisted reconnect state.
 */
export const JUST_BASH_PROVIDER = "just-bash";

/**
 * Construction input for the internal just-bash bridge behind
 * `JustBashSandbox`.
 */
export interface CreateJustBashSandboxEngineInput {
  readonly createOptions?: JustBashSandboxCreateOptions;
}

/**
 * Creates the just-bash sandbox provider.
 *
 * The cache directory is derived from the runtime context's `appRoot`
 * on every `create` call so the provider stays stateless and matches
 * the framework's per-call dispatch contract.
 */
export function createJustBashSandboxEngine(
  input: CreateJustBashSandboxEngineInput = {},
): SandboxEngine {
  const autoInstall = input.createOptions?.autoInstall ?? true;
  const configuration = parseJsonObject(input.createOptions ?? {});
  return {
    provider: JUST_BASH_PROVIDER,
    async prepare(prewarmInput: SandboxEnginePrepareInput): Promise<SandboxEnginePrepareResult> {
      const cacheDirectory = resolveSandboxCacheDirectory(prewarmInput.context.appRoot);
      const templateRootPath = resolveTemplateRootPath(cacheDirectory, prewarmInput.templateKey);

      if (await pathExists(templateRootPath)) {
        await touchDirectory(templateRootPath);
        return { reused: true };
      }

      const temporaryTemplateRootPath = `${templateRootPath}.${randomUUID()}.tmp`;
      let published = false;
      const templateSandbox = await createBashSandbox({
        appRoot: prewarmInput.context.appRoot,
        autoInstall,
        rootPath: temporaryTemplateRootPath,
        sessionKey: prewarmInput.templateKey,
      });
      const templateSession = buildSandboxSession(
        createFileBackedInternalSandboxSession({
          id: templateSandbox.sessionKey,
          sandbox: templateSandbox,
        }),
        justBashSetNetworkPolicyUnsupported,
      );

      try {
        await writeSandboxSeedFiles(templateSession, prewarmInput.seedFiles);

        if (prewarmInput.prepare !== undefined) {
          prewarmInput.log?.("running template preparation");
          await prewarmInput.prepare(
            createLoggingSandboxSession({
              log: prewarmInput.log,
              session: templateSession,
            }),
          );
        }

        const captured = await templateSandbox.captureState();
        if (captured === null) {
          throw new Error(
            `Failed to capture local sandbox template state for "${prewarmInput.templateKey}".`,
          );
        }

        await mkdir(dirname(templateRootPath), { recursive: true });
        try {
          await rename(temporaryTemplateRootPath, templateRootPath);
          published = true;
        } catch (error) {
          if (await pathExists(templateRootPath)) {
            return { reused: true };
          }
          throw error;
        }
      } finally {
        await templateSandbox.dispose();
        if (!published) {
          await rm(temporaryTemplateRootPath, { force: true, recursive: true }).catch(() => {});
        }
      }

      return { reused: false };
    },
    async create(createInput: SandboxEngineCreateInput): Promise<SandboxEngineHandle> {
      const cacheDirectory = resolveSandboxCacheDirectory(createInput.context.appRoot);
      const persistedIdentity = readPersistedJustBashIdentity(createInput.existingMetadata);
      const sessionRootPath =
        persistedIdentity?.rootPath ??
        resolveSessionRootPath(cacheDirectory, createInput.sessionKey);
      let createdSessionRoot = false;

      if (!(await pathExists(sessionRootPath))) {
        if (createInput.existingMetadata !== undefined) {
          throw new SandboxResourceUnavailableError({
            provider: JUST_BASH_PROVIDER,
            sessionKey: createInput.sessionKey,
          });
        }
        if (createInput.templateKey === null) {
          await mkdir(sessionRootPath, { recursive: true });
          createdSessionRoot = true;
        } else {
          const templateRootPath = resolveTemplateRootPath(cacheDirectory, createInput.templateKey);

          if (!(await pathExists(templateRootPath))) {
            throw new SandboxTemplateUnavailableError({
              provider: JUST_BASH_PROVIDER,
              templateKey: createInput.templateKey,
            });
          }

          await copyDirectoryAtomically(templateRootPath, sessionRootPath);
          createdSessionRoot = true;
        }
      }

      const sandbox = await createBashSandbox({
        appRoot: createInput.context.appRoot,
        autoInstall,
        resourceId: createdSessionRoot ? randomUUID() : undefined,
        rootPath: sessionRootPath,
        sessionKey: createInput.sessionKey,
      });
      if (persistedIdentity !== undefined && sandbox.resourceId !== persistedIdentity.resourceId) {
        await sandbox.dispose();
        throw new SandboxResourceUnavailableError({
          provider: JUST_BASH_PROVIDER,
          sessionKey: createInput.sessionKey,
        });
      }

      return createJustBashHandle(sandbox, JUST_BASH_PROVIDER, configuration);
    },
  };
}

/**
 * Removes stale just-bash sandbox template directories for one
 * application's cache.
 */
export async function pruneJustBashSandboxTemplates(input: {
  readonly appRoot: string;
  readonly now?: number;
  readonly recentWindowMs?: number;
  readonly retainCount?: number;
}): Promise<void> {
  const templatesDirectory = resolveLocalProviderTemplatesDirectory(
    resolveSandboxCacheDirectory(input.appRoot),
    JUST_BASH_CACHE_DIRECTORY_NAME,
  );
  const now = input.now ?? Date.now();
  const recentWindowMs = input.recentWindowMs ?? LOCAL_SANDBOX_TEMPLATE_RECENT_WINDOW_MS;
  const retainCount = input.retainCount ?? LOCAL_SANDBOX_TEMPLATE_RETAIN_COUNT;

  let entries: Dirent<string>[];
  try {
    entries = await readdir(templatesDirectory, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }

  const directories = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory())
      .map(async (entry) => {
        const path = join(templatesDirectory, entry.name);
        return {
          isTemporary: entry.name.endsWith(".tmp"),
          mtimeMs: (await stat(path)).mtimeMs,
          path,
        };
      }),
  );

  const staleTemplates = selectStaleTemplateEntries(
    directories.filter((directory) => !directory.isTemporary),
    { now, recentWindowMs, retainCount },
  );
  // Temporary build directories are garbage as soon as they fall out of
  // the recency window — they only exist while a publish is in flight.
  const staleTemporaries = selectStaleTemplateEntries(
    directories.filter((directory) => directory.isTemporary),
    { now, recentWindowMs, retainCount: 0 },
  );

  await Promise.all(
    [...staleTemplates, ...staleTemporaries].map(
      async (entry) => await rm(entry.path, { force: true, recursive: true }),
    ),
  );
}

function resolveTemplateRootPath(cacheDirectory: string, templateKey: string): string {
  return resolveLocalProviderTemplateRootPath(
    cacheDirectory,
    JUST_BASH_CACHE_DIRECTORY_NAME,
    templateKey,
  );
}

function resolveSessionRootPath(cacheDirectory: string, sessionKey: string): string {
  return resolveLocalProviderSessionRootPath(
    cacheDirectory,
    JUST_BASH_CACHE_DIRECTORY_NAME,
    sessionKey,
  );
}

function readPersistedJustBashIdentity(
  metadata: Record<string, unknown> | undefined,
): { readonly resourceId: string; readonly rootPath: string } | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  if (typeof metadata.resourceId !== "string" || typeof metadata.rootPath !== "string") {
    throw new TypeError("Invalid persisted just-bash sandbox identity.");
  }
  return {
    resourceId: metadata.resourceId,
    rootPath: metadata.rootPath,
  };
}
