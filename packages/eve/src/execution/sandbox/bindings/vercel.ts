import {
  applyInitialVercelNetworkPolicy,
  ensureVercelSandboxBaseRuntime,
} from "#execution/sandbox/bindings/vercel-base-runtime.js";
import type {
  SandboxEngine,
  SandboxEngineCreateInput,
  SandboxEngineHandle,
  SandboxEnginePrepareInput,
  SandboxEnginePrepareResult,
  SandboxResourceTags,
  SandboxSeedFile,
} from "#shared/sandbox-engine.js";
import {
  SandboxResourceUnavailableError,
  SandboxTemplateUnavailableError,
} from "#shared/sandbox-engine.js";
import { createLoggingSandboxSession } from "#execution/sandbox/logging-session.js";
import { buildSandboxSession } from "#execution/sandbox/session.js";
import {
  createVercelEveImageSandbox,
  type CreateVercelSandbox,
  type VercelSandboxCreateParams,
} from "#execution/sandbox/bindings/vercel-create-sdk.js";
import {
  isVercelSandboxMissingError,
  isVercelSnapshotUnavailableError,
} from "#execution/sandbox/bindings/vercel-errors.js";
import { getNamedVercelSandbox } from "#execution/sandbox/bindings/vercel-lookup.js";
import {
  createVercelInternalSandboxSession,
  createVercelNetworkPolicySetter,
  createVercelSandboxHandle,
} from "#execution/sandbox/bindings/vercel-session.js";
import { writeSandboxSeedFiles } from "#execution/sandbox/bindings/local-workspace-utils.js";
import type {
  VercelCreateOptions,
  VercelModule,
  VercelSandbox,
} from "#execution/sandbox/bindings/vercel-sdk-types.js";
import { parseJsonObject, type JsonObject } from "#shared/json.js";

export interface CreateVercelSandboxInput {
  readonly createSandbox?: CreateVercelSandbox;
  readonly createOptions?: VercelCreateOptions;
  readonly loadSandboxModule?: () => Promise<VercelModule>;
}
/**
 * Creates the Vercel-backed sandbox provider.
 *
 * Any author-supplied `createOptions` are forwarded to Vercel's sandbox
 * create API for every fresh sandbox the framework creates (template at
 * prewarm time, session at first-time session-create). On resume
 * (`Sandbox.get`) no create happens, so they are not re-applied.
 */
export function createVercelSandbox(input: CreateVercelSandboxInput = {}): SandboxEngine {
  const loadSandboxModule =
    input.loadSandboxModule ?? (async () => await import("#compiled/@vercel/sandbox/index.js"));
  const createOptions: VercelCreateOptions = {
    timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
    ...input.createOptions,
  };
  const configuration = createVercelRestorationConfiguration(createOptions);
  const createSandbox = input.createSandbox ?? createVercelEveImageSandbox;
  const prewarmedTemplates = new Map<string, VercelSandboxTemplateRecord>();

  return {
    provider: "vercel",
    async create(createInput: SandboxEngineCreateInput): Promise<SandboxEngineHandle> {
      const runtimeCreateOptions =
        createInput.signal === undefined
          ? createOptions
          : { ...createOptions, signal: createInput.signal };
      const tags =
        createInput.existingMetadata === undefined || createInput.tags !== undefined
          ? resolveVercelSandboxTags(runtimeCreateOptions.tags, createInput.tags)
          : undefined;

      const template =
        createInput.templateKey === null
          ? null
          : createInput.templateReference === undefined
            ? await readTemplateForCreate({
                createOptions: runtimeCreateOptions,
                loadSandboxModule,
                prewarmedTemplates,
                templateKey: createInput.templateKey,
              })
            : parseVercelTemplateReference(createInput.templateReference, createInput.templateKey);

      const sandboxModule = await loadSandboxModule();
      let session: VercelSandboxSessionCreateResult;
      try {
        session = await ensureSession({
          createOptions: runtimeCreateOptions,
          createSandbox,
          existingMetadata: createInput.existingMetadata,
          sandboxModule,
          sessionKey: createInput.sessionKey,
          snapshotId: template?.snapshotId,
          tags,
        });
      } catch (error) {
        if (SandboxResourceUnavailableError.is(error)) {
          throw error;
        }
        if (
          template !== null &&
          (isVercelSnapshotUnavailableError(error) || isVercelSandboxMissingError(error))
        ) {
          prewarmedTemplates.delete(template.templateKey);
          const staleTemplate = await getNamedVercelSandbox({
            createOptions,
            sandboxModule,
            sandboxName: template.sandboxName,
          });
          await staleTemplate?.delete();
          throw new SandboxTemplateUnavailableError({
            provider: "vercel",
            templateKey: template.templateKey,
          });
        }
        throw new Error(
          `Failed to create sandbox session "${createInput.sessionKey}": ${errorMessage(error)}`,
          { cause: error },
        );
      }

      if (template === null && session.created) {
        await ensureVercelSandboxBaseRuntime(session.sandbox);
        await applyInitialVercelNetworkPolicy(session.sandbox, createOptions.networkPolicy);
      }

      return createVercelSandboxHandle(session.sandbox, createInput.sessionKey, configuration);
    },
    async prepare(prewarmInput: SandboxEnginePrepareInput): Promise<SandboxEnginePrepareResult> {
      let outcome: EnsureTemplateOutcome;
      try {
        outcome = await ensureTemplateWithUnavailableRetry({
          prepare: prewarmInput.prepare,
          createOptions,
          createSandbox,
          loadSandboxModule,
          log: prewarmInput.log,
          seedFiles: prewarmInput.seedFiles,
          templateKey: prewarmInput.templateKey,
        });
      } catch (error) {
        throw new Error(
          `Failed to prewarm Vercel sandbox template "${prewarmInput.templateKey}": ${errorMessage(error)}`,
          { cause: error },
        );
      }
      prewarmedTemplates.set(prewarmInput.templateKey, outcome.template);
      return {
        reused: outcome.reused,
        reference: outcome.template,
      };
    },
  };
}

interface VercelSandboxTemplateRecord extends JsonObject {
  readonly sandboxName: string;
  readonly snapshotId: string;
  readonly templateKey: string;
}

function parseVercelTemplateReference(
  reference: Record<string, unknown>,
  templateKey: string,
): VercelSandboxTemplateRecord {
  if (
    typeof reference.sandboxName !== "string" ||
    typeof reference.snapshotId !== "string" ||
    reference.templateKey !== templateKey
  ) {
    throw new Error(`Invalid frozen Vercel sandbox template reference "${templateKey}".`);
  }
  return {
    sandboxName: reference.sandboxName,
    snapshotId: reference.snapshotId,
    templateKey,
  };
}

interface EnsureTemplateOutcome {
  readonly reused: boolean;
  readonly template: VercelSandboxTemplateRecord;
}

interface EnsureTemplateInput {
  readonly prepare?: SandboxEnginePrepareInput["prepare"];
  readonly createOptions: VercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly log?: (message: string) => void;
  readonly seedFiles: ReadonlyArray<SandboxSeedFile>;
  readonly tags?: SandboxResourceTags;
  readonly templateKey: string;
}

async function ensureTemplateWithUnavailableRetry(
  input: EnsureTemplateInput,
): Promise<EnsureTemplateOutcome> {
  try {
    return await ensureTemplate(input);
  } catch (error) {
    if (!isVercelSnapshotUnavailableError(error) && !isVercelSandboxMissingError(error)) {
      throw error;
    }
    input.log?.("cached template disappeared; rebuilding sandbox template");
    return await ensureTemplate(input);
  }
}

async function readTemplate(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly prewarmedTemplates: ReadonlyMap<string, VercelSandboxTemplateRecord>;
  readonly templateKey: string;
}): Promise<VercelSandboxTemplateRecord> {
  const prewarmed = input.prewarmedTemplates.get(input.templateKey);
  if (prewarmed !== undefined) {
    return prewarmed;
  }

  const sandboxModule = await input.loadSandboxModule();
  const sandbox = await getNamedVercelSandbox({
    createOptions: input.createOptions,
    sandboxModule,
    sandboxName: input.templateKey,
  });

  if (sandbox === null || typeof sandbox.currentSnapshotId !== "string") {
    throw new SandboxTemplateUnavailableError({
      provider: "vercel",
      templateKey: input.templateKey,
    });
  }

  return {
    sandboxName: sandbox.name,
    snapshotId: sandbox.currentSnapshotId,
    templateKey: input.templateKey,
  };
}

async function readTemplateForCreate(input: {
  readonly createOptions: VercelCreateOptions;
  readonly loadSandboxModule: () => Promise<VercelModule>;
  readonly prewarmedTemplates: ReadonlyMap<string, VercelSandboxTemplateRecord>;
  readonly templateKey: string;
}): Promise<VercelSandboxTemplateRecord> {
  try {
    return await readTemplate(input);
  } catch (error) {
    if (SandboxTemplateUnavailableError.is(error)) {
      throw error;
    }
    throw new Error(
      `Failed to read sandbox template "${input.templateKey}": ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

/**
 * Creates or refreshes one named Vercel sandbox template and returns the
 * resulting snapshot metadata along with whether an existing snapshot
 * was reused. Internal — exposed only to the prewarm pipeline through
 * the provider engine's `prepare` method.
 */
async function ensureTemplate(input: EnsureTemplateInput): Promise<EnsureTemplateOutcome> {
  const sandboxModule = await input.loadSandboxModule();
  let sandbox = await getNamedVercelSandbox({
    createOptions: input.createOptions,
    sandboxModule,
    sandboxName: input.templateKey,
  });
  const tags = resolveVercelSandboxTags(input.createOptions.tags, input.tags);
  const authorSnapshotId = extractAuthorSnapshotId(input.createOptions);

  if (
    sandbox !== null &&
    hasFrameworkSnapshot(sandbox, authorSnapshotId) &&
    !hasImmutableTemplateBase(input.createOptions)
  ) {
    input.log?.("template base is not immutable; rebuilding sandbox template");
    await sandbox.delete();
    sandbox = null;
  }

  if (sandbox !== null && isUnprovisionedTerminalTemplateSandbox(sandbox, authorSnapshotId)) {
    await sandbox.delete();
    sandbox = null;
  }

  if (sandbox === null) {
    sandbox = await input.createSandbox({
      sandboxModule,
      createOptions: withBaseSetupNetworkPolicy({
        ...input.createOptions,
        name: input.templateKey,
        persistent: false,
        tags: tags,
      }),
    });
  } else {
    await ensureVercelSandboxTags(sandbox, tags);
  }

  /*
   * A non-empty `currentSnapshotId` normally means "this template was
   * prewarmed in a previous run — reuse it." But with an author-supplied
   * `source: snapshot`, the SDK pre-populates `currentSnapshotId` with
   * the *author's* snapshotId both on a fresh create and on every
   * subsequent `getNamedSandbox` reuse until we run our own snapshot.
   * So we ignore that exact value: it's the author's base layer, not a
   * framework snapshot, and we still owe `ensureSandboxWorkingDirectory`,
   * preparation, managed file writes, and `sandbox.snapshot()` on top.
   */
  if (hasFrameworkSnapshot(sandbox, authorSnapshotId)) {
    return {
      reused: true,
      template: {
        sandboxName: sandbox.name,
        snapshotId: sandbox.currentSnapshotId as string,
        templateKey: input.templateKey,
      },
    };
  }

  try {
    input.log?.("preparing base runtime inside sandbox");
    await ensureVercelSandboxBaseRuntime(sandbox);
    await applyInitialVercelNetworkPolicy(sandbox, input.createOptions.networkPolicy);

    const templateSession = buildSandboxSession(
      createVercelInternalSandboxSession(sandbox, input.templateKey),
      createVercelNetworkPolicySetter(sandbox),
    );

    await writeSandboxSeedFiles(templateSession, input.seedFiles);

    if (input.prepare !== undefined) {
      input.log?.("running template preparation");
      await input.prepare(
        createLoggingSandboxSession({
          log: input.log,
          session: templateSession,
        }),
      );
    }

    const snapshot = await sandbox.snapshot();
    return {
      reused: false,
      template: {
        sandboxName: sandbox.name,
        snapshotId: snapshot.snapshotId,
        templateKey: input.templateKey,
      },
    };
  } catch (error) {
    await sandbox.delete().catch(() => {});
    throw error;
  }
}

interface EnsureSessionInput {
  readonly createOptions: VercelCreateOptions;
  readonly createSandbox: CreateVercelSandbox;
  readonly existingMetadata?: Record<string, unknown>;
  readonly sandboxModule: VercelModule;
  readonly sessionKey: string;
  readonly snapshotId?: string;
  readonly tags: Record<string, string> | undefined;
}

interface VercelSandboxSessionCreateResult {
  readonly created: boolean;
  readonly sandbox: VercelSandbox;
}

async function ensureSession(input: EnsureSessionInput): Promise<VercelSandboxSessionCreateResult> {
  const persistedIdentity = readPersistedVercelSandboxIdentity(input.existingMetadata);
  const sandboxName = persistedIdentity?.name ?? input.sessionKey;
  const existing = await getNamedVercelSandbox({
    createOptions: input.createOptions,
    sandboxModule: input.sandboxModule,
    sandboxName,
  });

  if (existing !== null) {
    if (
      persistedIdentity !== undefined &&
      existing.createdAt.toISOString() !== persistedIdentity.createdAt
    ) {
      throw new SandboxResourceUnavailableError({
        provider: "vercel",
        sessionKey: sandboxName,
      });
    }
    await ensureVercelSandboxTags(existing, input.tags);
    return { created: false, sandbox: existing };
  }
  if (input.existingMetadata !== undefined) {
    throw new SandboxResourceUnavailableError({
      provider: "vercel",
      sessionKey: sandboxName,
    });
  }

  const createParams = createSessionCreateParams(input, sandboxName);
  if (input.tags !== undefined) {
    createParams.tags = input.tags;
  }

  try {
    return {
      created: true,
      sandbox: await input.createSandbox({
        createOptions: createParams,
        sandboxModule: input.sandboxModule,
      }),
    };
  } catch (error) {
    const raced = await getNamedVercelSandbox({
      createOptions: createParams,
      sandboxModule: input.sandboxModule,
      sandboxName,
    });
    if (raced !== null) {
      await ensureVercelSandboxTags(raced, input.tags);
      return { created: false, sandbox: raced };
    }
    throw error;
  }
}

function createSessionCreateParams(
  input: EnsureSessionInput,
  sandboxName: string,
): VercelSandboxCreateParams {
  if (input.snapshotId === undefined) {
    return withBaseSetupNetworkPolicy({
      ...input.createOptions,
      name: sandboxName,
      persistent: true,
    });
  }

  /*
   * Strip `source`, `runtime`, and `image` from author-supplied create options
   * for the template-backed session path. The framework owns the source there,
   * and a snapshot source is mutually exclusive with both `runtime` and `image`
   * (the template snapshot already has the eve image baked in).
   */
  const {
    image: _image,
    runtime: _runtime,
    source: _source,
    ...sessionCreateOptions
  } = input.createOptions as VercelCreateOptions &
    Partial<Record<"image" | "runtime" | "source", unknown>>;

  return {
    ...sessionCreateOptions,
    name: sandboxName,
    persistent: true,
    source: { snapshotId: input.snapshotId, type: "snapshot" as const },
  };
}

function withBaseSetupNetworkPolicy(
  createOptions: VercelSandboxCreateParams,
): VercelSandboxCreateParams {
  return { ...createOptions, networkPolicy: "allow-all" };
}

function isUnprovisionedTerminalTemplateSandbox(
  sandbox: VercelSandbox,
  authorSnapshotId: string | undefined,
): boolean {
  const currentSnapshotId = sandbox.currentSnapshotId;
  if (
    typeof currentSnapshotId === "string" &&
    currentSnapshotId.length > 0 &&
    currentSnapshotId !== authorSnapshotId
  ) {
    return false;
  }

  return (
    sandbox.status === "aborted" || sandbox.status === "failed" || sandbox.status === "stopped"
  );
}

/**
 * Pulls the snapshotId out of an author-supplied `source: { type:
 * "snapshot", ... }`. Returns undefined for git/tarball sources or when
 * no source was supplied — those don't seed `currentSnapshotId` with a
 * pre-existing value the way snapshot sources do.
 */
function extractAuthorSnapshotId(createOptions: VercelCreateOptions): string | undefined {
  const source = (createOptions as { source?: { type?: string; snapshotId?: string } }).source;
  if (source?.type === "snapshot" && typeof source.snapshotId === "string") {
    return source.snapshotId;
  }
  return undefined;
}

function hasFrameworkSnapshot(
  sandbox: VercelSandbox,
  authorSnapshotId: string | undefined,
): boolean {
  return (
    typeof sandbox.currentSnapshotId === "string" &&
    sandbox.currentSnapshotId.length > 0 &&
    sandbox.currentSnapshotId !== authorSnapshotId
  );
}

function hasImmutableTemplateBase(createOptions: VercelCreateOptions): boolean {
  const source = (
    createOptions as {
      readonly image?: string;
      readonly source?:
        | { readonly type?: string; readonly revision?: string; readonly snapshotId?: string }
        | undefined;
    }
  ).source;
  const image = (createOptions as { readonly image?: string }).image;

  if (source === undefined && image === undefined) {
    return false;
  }

  if (source?.type === "snapshot" && typeof source.snapshotId === "string") {
    return true;
  }
  if (
    source?.type === "git" &&
    typeof source.revision === "string" &&
    /^[a-f0-9]{40}$/i.test(source.revision)
  ) {
    return true;
  }

  return typeof image === "string" && /@sha256:[a-f0-9]{64}$/i.test(image);
}

function createVercelRestorationConfiguration(createOptions: VercelCreateOptions): JsonObject {
  const configuration: Record<string, unknown> = {};
  for (const key of ["projectId", "teamId"] as const) {
    const value = (createOptions as Record<string, unknown>)[key];
    if (typeof value === "string" && value.trim().length > 0) {
      configuration[key] = value;
    }
  }
  if (createOptions.tags !== undefined) {
    configuration.tags = { ...createOptions.tags };
  }
  return parseJsonObject(configuration);
}

function readPersistedVercelSandboxIdentity(
  metadata: Record<string, unknown> | undefined,
): { readonly createdAt: string; readonly name: string } | undefined {
  if (metadata === undefined) {
    return undefined;
  }
  if (typeof metadata.sandboxCreatedAt !== "string" || typeof metadata.sandboxName !== "string") {
    throw new TypeError("Invalid persisted Vercel sandbox identity.");
  }
  return {
    createdAt: metadata.sandboxCreatedAt,
    name: metadata.sandboxName,
  };
}

function resolveVercelSandboxTags(
  userTags: VercelCreateOptions["tags"],
  eveTags: SandboxResourceTags | undefined,
): Record<string, string> | undefined {
  const tags: Record<string, string> = {};

  if (userTags !== undefined) {
    for (const [key, value] of Object.entries(userTags as Record<string, string>)) {
      tags[key] = value;
    }
  }

  if (eveTags !== undefined) {
    for (const [key, value] of Object.entries(eveTags)) {
      tags[key] = value;
    }
  }

  const count = Object.keys(tags).length;
  if (count === 0) {
    return undefined;
  }

  if (count > VERCEL_SANDBOX_TAG_LIMIT) {
    throw new Error(
      `Vercel Sandbox supports at most ${VERCEL_SANDBOX_TAG_LIMIT} tags. ` +
        'eve reserves "agent", "channel", and "sessionId"; remove or consolidate custom VercelSandbox tags.',
    );
  }

  return tags;
}

async function ensureVercelSandboxTags(
  sandbox: VercelSandbox,
  tags: Record<string, string> | undefined,
): Promise<void> {
  if (tags === undefined || areVercelSandboxTagsEqual(sandbox.tags, tags)) {
    return;
  }

  await sandbox.update({ tags });
}

function areVercelSandboxTagsEqual(
  current: Record<string, string> | undefined,
  next: Record<string, string>,
): boolean {
  const currentTags = current ?? {};
  const currentEntries = Object.entries(currentTags);
  const nextEntries = Object.entries(next);

  if (currentEntries.length !== nextEntries.length) {
    return false;
  }

  return nextEntries.every(([key, value]) => currentTags[key] === value);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const responseJson = (error as { readonly json?: unknown }).json;
    const responseText = (error as { readonly text?: unknown }).text;
    const responseBody =
      typeof responseText === "string" && responseText.length > 0
        ? responseText
        : responseJson !== undefined
          ? JSON.stringify(responseJson)
          : undefined;
    if (responseBody !== undefined) {
      return `${error.message}: ${responseBody}`;
    }
    return error.message;
  }
  return String(error);
}

/**
 * 30 minutes. The `@vercel/sandbox` SDK defaults to 5 minutes which is
 * too short for multi-step workflows — the VM expires between steps.
 */
const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;

const VERCEL_SANDBOX_TAG_LIMIT = 5;
