import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import {
  createFileBackedInternalSandboxSession,
  touchDirectory,
  writeSandboxSeedFiles,
} from "#execution/sandbox/bindings/local-workspace-utils.js";
import {
  MICROSANDBOX_METADATA_VERSION,
  readSessionMetadata,
  readSessionMetadataRecord,
  readTemplateMetadata,
  resolveMicrosandboxMetadataPath,
  writeTemplateMetadata,
} from "#execution/sandbox/bindings/microsandbox-metadata.js";
import type { ResolvedMicrosandboxOptions } from "#execution/sandbox/bindings/microsandbox-options.js";
import {
  connectMicrosandbox,
  createPreparedMicrosandbox,
  createProviderName,
  doesPathExist,
  isMicrosandboxNotFoundError,
  loadMicrosandboxModule,
  type MicrosandboxVm,
  removeSnapshotIfExists,
  sandboxExists,
  snapshotExists,
} from "#execution/sandbox/bindings/microsandbox-runtime.js";
import {
  resolveMicrosandboxSessionRootPath,
  resolveMicrosandboxTemplateRootPath,
} from "#execution/sandbox/bindings/microsandbox-templates.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { withDevelopmentSandboxMetadataPathTag } from "#execution/sandbox/development-run.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import { resolveSandboxCacheDirectory } from "#internal/application/paths.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";
import type {
  SandboxEngineCreateInput,
  SandboxEngineHandle,
  SandboxEnginePrepareInput,
  SandboxEnginePrepareResult,
} from "#shared/sandbox-engine.js";
import {
  SandboxResourceUnavailableError,
  SandboxTemplateUnavailableError,
} from "#shared/sandbox-engine.js";
import type { InternalSandboxSession } from "#shared/sandbox-session.js";

const activeMicrosandboxSessionHandles = new Map<string, SandboxEngineHandle>();

export async function prewarmMicrosandboxTemplate(input: {
  readonly provider: string;
  readonly options: ResolvedMicrosandboxOptions;
  readonly optionsHash: string;
  readonly prewarmInput: SandboxEnginePrepareInput;
}): Promise<SandboxEnginePrepareResult> {
  input.prewarmInput.log?.("loading microsandbox runtime");
  const module = await loadMicrosandboxModule({
    appRoot: input.prewarmInput.context.appRoot,
    log: input.prewarmInput.log,
    options: input.options,
  });
  const cacheDirectory = resolveSandboxCacheDirectory(input.prewarmInput.context.appRoot);
  const templateRootPath = resolveMicrosandboxTemplateRootPath(
    cacheDirectory,
    input.prewarmInput.templateKey,
  );
  const metadataPath = resolveMicrosandboxMetadataPath(templateRootPath);
  input.prewarmInput.log?.("checking cached snapshot");
  const existing = await readTemplateMetadata(metadataPath);

  if (
    existing?.optionsHash === input.optionsHash &&
    input.options.pullPolicy !== "always" &&
    isImmutableOciImageReference(input.options.image) &&
    (await snapshotExists(module, existing.snapshotName))
  ) {
    input.prewarmInput.log?.("reusing cached snapshot");
    await touchDirectory(templateRootPath);
    return { reused: true };
  }

  const snapshotName = createProviderName(
    "eve-sbx-tpl",
    input.prewarmInput.templateKey,
    input.optionsHash,
  );
  const temporaryTemplateRootPath = `${templateRootPath}.${randomUUID()}.tmp`;
  const temporarySandboxName = createProviderName(
    "eve-sbx-tpl-tmp",
    `${input.prewarmInput.templateKey}:${randomUUID()}`,
  );

  await removeSnapshotIfExists(module, snapshotName);
  await rm(temporaryTemplateRootPath, { force: true, recursive: true });
  await mkdir(temporaryTemplateRootPath, { recursive: true });

  input.prewarmInput.log?.(`creating template VM from image "${input.options.image}"`);
  const templateSandbox = await createPreparedMicrosandbox({
    log: input.prewarmInput.log,
    module,
    name: temporarySandboxName,
    networkPolicy: input.options.networkPolicy,
    options: input.options,
    sessionKey: input.prewarmInput.templateKey,
    setupBaseRuntime: true,
    tags: undefined,
  });
  const templateSession = buildSandboxSession(
    createMicrosandboxInternalSession(templateSandbox),
    async (policy) => {
      await templateSandbox.setNetworkPolicy(policy);
    },
  );

  try {
    if (input.prewarmInput.seedFiles.length > 0) {
      input.prewarmInput.log?.(`writing ${input.prewarmInput.seedFiles.length} seed file(s)`);
    }
    await writeSandboxSeedFiles(templateSession, input.prewarmInput.seedFiles);

    if (input.prewarmInput.prepare !== undefined) {
      input.prewarmInput.log?.("running template preparation");
      await input.prewarmInput.prepare(
        createLoggingSandboxSession({
          log: input.prewarmInput.log,
          session: templateSession,
        }),
      );
    }

    input.prewarmInput.log?.("snapshotting template VM");
    await templateSandbox.stopAndSnapshot(snapshotName);
    await writeTemplateMetadata(resolveMicrosandboxMetadataPath(temporaryTemplateRootPath), {
      optionsHash: input.optionsHash,
      snapshotName,
      version: MICROSANDBOX_METADATA_VERSION,
    });

    await mkdir(dirname(templateRootPath), { recursive: true });
    await rm(templateRootPath, { force: true, recursive: true });
    try {
      await rename(temporaryTemplateRootPath, templateRootPath);
    } catch (error) {
      if (await doesPathExist(templateRootPath)) {
        return { reused: true };
      }
      throw error;
    }
  } finally {
    await templateSandbox.removePersisted();
    await rm(temporaryTemplateRootPath, { force: true, recursive: true }).catch(() => {});
  }

  return { reused: false };
}

export async function createMicrosandboxHandle(input: {
  readonly provider: string;
  readonly configuration?: JsonObject;
  readonly createInput: SandboxEngineCreateInput;
  readonly options: ResolvedMicrosandboxOptions;
  readonly optionsHash: string;
}): Promise<SandboxEngineHandle> {
  const module = await loadMicrosandboxModule({
    appRoot: input.createInput.context.appRoot,
    options: input.options,
  });
  const cacheDirectory = resolveSandboxCacheDirectory(input.createInput.context.appRoot);
  const sessionRootPath = resolveMicrosandboxSessionRootPath(
    cacheDirectory,
    input.createInput.sessionKey,
  );
  const activeSessionKey = createActiveMicrosandboxSessionKey(sessionRootPath, input.optionsHash);
  const activeHandle = activeMicrosandboxSessionHandles.get(activeSessionKey);
  if (activeHandle !== undefined) {
    return activeHandle;
  }

  const metadataPath = resolveMicrosandboxMetadataPath(sessionRootPath);
  const existingMetadata =
    readSessionMetadataRecord(input.createInput.existingMetadata) ??
    (await readSessionMetadata(metadataPath));
  const sessionTags = withDevelopmentSandboxMetadataPathTag(input.createInput.tags, metadataPath);

  if (
    existingMetadata?.optionsHash === input.optionsHash &&
    ((await sandboxExists(module, existingMetadata.sandboxName)) ||
      (existingMetadata.stateSnapshotName !== undefined &&
        (await snapshotExists(module, existingMetadata.stateSnapshotName))))
  ) {
    const sandbox = await connectMicrosandbox({
      metadata: existingMetadata,
      metadataPath,
      module,
      options: input.options,
      sessionKey: input.createInput.sessionKey,
      tags: sessionTags,
    });
    if (sandbox !== null) {
      return cacheHandle(
        activeSessionKey,
        createHandle(sandbox, input.provider, input.configuration ?? {}, input.optionsHash, () => {
          activeMicrosandboxSessionHandles.delete(activeSessionKey);
        }),
      );
    }
  }

  if (input.createInput.existingMetadata !== undefined) {
    throw new SandboxResourceUnavailableError({
      provider: input.provider,
      sessionKey: input.createInput.sessionKey,
    });
  }

  let snapshotName: string | null = null;
  if (input.createInput.templateKey !== null) {
    const templateRootPath = resolveMicrosandboxTemplateRootPath(
      cacheDirectory,
      input.createInput.templateKey,
    );
    const templateMetadata = await readTemplateMetadata(
      resolveMicrosandboxMetadataPath(templateRootPath),
    );

    if (
      templateMetadata === null ||
      templateMetadata.optionsHash !== input.optionsHash ||
      !(await snapshotExists(module, templateMetadata.snapshotName))
    ) {
      throw new SandboxTemplateUnavailableError({
        provider: input.provider,
        templateKey: input.createInput.templateKey,
      });
    }

    snapshotName = templateMetadata.snapshotName;
  }

  const sandboxName = createProviderName(
    "eve-sbx-ses",
    `${input.createInput.sessionKey}:${randomUUID()}`,
  );
  let sandbox: MicrosandboxVm;
  try {
    sandbox = await createPreparedMicrosandbox({
      fromSnapshot: snapshotName ?? undefined,
      module,
      name: sandboxName,
      networkPolicy: input.options.networkPolicy,
      options: input.options,
      sessionKey: input.createInput.sessionKey,
      setupBaseRuntime: snapshotName === null,
      tags: sessionTags,
    });
  } catch (error) {
    if (
      snapshotName !== null &&
      input.createInput.templateKey !== null &&
      isMicrosandboxNotFoundError(error)
    ) {
      throw new SandboxTemplateUnavailableError({
        provider: input.provider,
        templateKey: input.createInput.templateKey,
      });
    }
    throw error;
  }

  await sandbox.writeMetadata(metadataPath, input.optionsHash);
  return cacheHandle(
    activeSessionKey,
    createHandle(sandbox, input.provider, input.configuration ?? {}, input.optionsHash, () => {
      activeMicrosandboxSessionHandles.delete(activeSessionKey);
    }),
  );
}

function createHandle(
  sandbox: MicrosandboxVm,
  provider: string,
  configuration: JsonObject,
  optionsHash: string,
  onShutdown?: () => void,
): SandboxEngineHandle {
  const session = buildSandboxSession(
    createMicrosandboxInternalSession(sandbox),
    async (policy) => {
      await sandbox.setNetworkPolicy(policy);
    },
  );
  return {
    session,
    async captureState() {
      const metadata = await sandbox.captureState(optionsHash);
      return {
        configuration,
        provider: provider,
        metadata: parseJsonObject(metadata),
        sessionKey: sandbox.id,
      };
    },
    async shutdown() {
      onShutdown?.();
      await sandbox.shutdown();
    },
  };
}

function createMicrosandboxInternalSession(sandbox: MicrosandboxVm): InternalSandboxSession {
  return createFileBackedInternalSandboxSession({ id: sandbox.id, sandbox });
}

function createActiveMicrosandboxSessionKey(sessionRootPath: string, optionsHash: string): string {
  return `${sessionRootPath}\0${optionsHash}`;
}

function cacheHandle(key: string, handle: SandboxEngineHandle): SandboxEngineHandle {
  activeMicrosandboxSessionHandles.set(key, handle);
  return handle;
}

export function clearActiveMicrosandboxSessionHandlesForTest(): void {
  activeMicrosandboxSessionHandles.clear();
}

function isImmutableOciImageReference(image: string): boolean {
  return /@sha256:[a-f0-9]{64}$/i.test(image);
}
