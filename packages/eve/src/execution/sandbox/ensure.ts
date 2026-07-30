import type { SessionContext } from "#public/definitions/callback-context.js";
import { SandboxTemplateUnavailableError } from "#shared/sandbox-engine.js";
import { isEveDevEnvironment } from "#internal/application/optional-package-install.js";
import {
  getRuntimeCompiledArtifactsSandboxAppRoot,
  type RuntimeCompiledArtifactsSource,
} from "#runtime/compiled-artifacts-source.js";
import { waitForDevelopmentSandboxPrewarm } from "#execution/sandbox/development-prewarm.js";
import { trackActiveSandboxHandle } from "#execution/sandbox/active-handles.js";
import { prewarmAppSandboxes } from "#execution/sandbox/prewarm.js";
import { waitForSandboxTemplatePrewarmLock } from "#execution/sandbox/template-prewarm-lock.js";
import {
  createRuntimeSandboxDefinitionRevision,
  createRuntimeSandboxSessionKey,
  createRuntimeSandboxTemplateKey,
} from "#runtime/sandbox/keys.js";
import type { RuntimeSandboxRegistry } from "#runtime/sandbox/registry.js";
import type {
  SandboxAccess,
  SandboxOwner,
  SandboxState,
  SandboxStateValue,
} from "#sandbox/state.js";
import {
  getSandboxAdapterType,
  isSandbox,
  restoreSandbox,
  serializeSandbox,
  shutdownSandbox,
  withSandboxProviderContext,
  type Sandbox,
} from "#shared/sandbox-value.js";
import {
  getSandboxTemplateInternal,
  hasSandboxTemplateReference,
  readSandboxTemplateReference,
  withSandboxTemplateBindings,
} from "#shared/sandbox-template.js";

export interface EnsureSandboxAccessInput {
  readonly compiledArtifactsSource: RuntimeCompiledArtifactsSource;
  readonly nodeId: string;
  readonly parentState?: SandboxStateValue;
  readonly registry: RuntimeSandboxRegistry;
  readonly rootState?: SandboxStateValue;
  readonly signal?: AbortSignal;
  readonly session: SessionContext["session"];
  readonly sessionId: string;
  readonly state: SandboxState | null;
  readonly tags?: Readonly<Record<string, string>>;
}

const sandboxOwners = new WeakMap<Sandbox, SandboxOwner>();

/**
 * Restores the persisted sandbox value or invokes the authored definition once
 * to obtain it.
 */
export async function ensureSandboxAccess(input: EnsureSandboxAccessInput): Promise<SandboxAccess> {
  const registered = input.registry.sandbox;
  if (registered === null) {
    return {
      async captureState() {
        return null;
      },
      async get() {
        return null;
      },
    };
  }
  const appRoot =
    getRuntimeCompiledArtifactsSandboxAppRoot(input.compiledArtifactsSource) ?? process.cwd();
  const revision = await createRuntimeSandboxDefinitionRevision({
    nodeId: input.nodeId,
    sourceHash: registered.definition.sourceHash,
    sourceId: registered.definition.sourceId,
    workspaceResourceRoot: registered.workspaceResourceRoot,
  });
  const sessionKey = await createRuntimeSandboxSessionKey({
    compiledArtifactsSource: input.compiledArtifactsSource,
    nodeId: input.nodeId,
    revision,
    sessionId: input.sessionId,
  });
  const templateBindings = await Promise.all(
    registered.definition.templates.map(async ({ exportName, reference, template }) => {
      const internal = getSandboxTemplateInternal(template);
      const templateKey = await createRuntimeSandboxTemplateKey({
        compiledArtifactsSource: input.compiledArtifactsSource,
        exportName,
        implementationId: internal.implementationId,
        nodeId: input.nodeId,
        revision,
      });
      return { internal, reference, templateKey };
    }),
  );

  function createTemplateBindings(): ReadonlyMap<
    ReturnType<typeof getSandboxTemplateInternal>,
    unknown
  > {
    const bindings = new Map<ReturnType<typeof getSandboxTemplateInternal>, unknown>();
    for (const { internal, reference, templateKey } of templateBindings) {
      const exactReference = hasSandboxTemplateReference(templateKey)
        ? readSandboxTemplateReference(templateKey)
        : reference;
      if (exactReference !== undefined) {
        bindings.set(internal, exactReference);
      }
    }
    return bindings;
  }

  let persistedState =
    input.state !== null && input.state.revision === revision ? input.state : null;
  let sandboxPromise: Promise<Sandbox> | undefined;

  function getSandbox(): Promise<Sandbox> {
    if (sandboxPromise !== undefined) {
      return sandboxPromise;
    }
    sandboxPromise = createOrRestoreSandbox().catch((error) => {
      sandboxPromise = undefined;
      throw error;
    });
    return sandboxPromise;
  }

  async function createOrRestoreSandbox(): Promise<Sandbox> {
    if (persistedState !== null) {
      const sandbox = restoreSandbox(persistedState.value, {
        appRoot,
        signal: input.signal,
        tags: input.tags,
      });
      sandboxOwners.set(sandbox, persistedState.owner);
      trackSandboxForShutdown(sandbox);
      return sandbox;
    }

    if (templateBindings.length > 0) {
      await waitForDevelopmentSandboxPrewarm({
        appRoot,
        compiledArtifactsSource: input.compiledArtifactsSource,
        log: logDevelopmentSandbox,
      });
      await Promise.all(
        templateBindings.map(async ({ internal, templateKey }) => {
          await waitForSandboxTemplatePrewarmLock({
            appRoot,
            provider: internal.implementationId,
            log: logDevelopmentSandbox,
            templateKey,
          });
        }),
      );
    }

    return await createFromDefinitionWithPrewarmRetry();
  }

  async function createFromDefinitionWithPrewarmRetry(): Promise<Sandbox> {
    try {
      return await invokeDefinition();
    } catch (error) {
      if (
        input.compiledArtifactsSource.kind !== "disk" ||
        !SandboxTemplateUnavailableError.is(error)
      ) {
        throw error;
      }

      await prewarmAppSandboxes({
        appRoot,
        compiledArtifactsSource: input.compiledArtifactsSource,
        log: logDevelopmentSandbox,
      });
      return await invokeDefinition();
    }
  }

  async function invokeDefinition(): Promise<Sandbox> {
    const signal = input.signal ?? new AbortController().signal;
    const ancestors = new Map<string, Sandbox>();
    const restoreAncestor = (state: SandboxStateValue): Sandbox => {
      const key = `${state.value.adapterId}\0${state.value.resourceId}`;
      const existing = ancestors.get(key);
      if (existing !== undefined) {
        return existing;
      }
      const sandbox = restoreSandboxState(state, {
        appRoot,
        signal,
      });
      ancestors.set(key, sandbox);
      return sandbox;
    };
    const sandbox = await withSandboxProviderContext(
      {
        appRoot,
        resourceId: sessionKey,
        signal,
        tags: input.tags,
      },
      async () =>
        await withSandboxTemplateBindings(createTemplateBindings(), async () => {
          return await registered.definition.definition({
            parent:
              input.parentState === undefined
                ? null
                : {
                    sandbox: Promise.resolve(restoreAncestor(input.parentState)),
                  },
            root:
              input.rootState === undefined
                ? null
                : {
                    sandbox: Promise.resolve(restoreAncestor(input.rootState)),
                  },
            runtime: {
              mode: isEveDevEnvironment() ? "development" : "production",
            },
            session: input.session,
            signal,
          });
        }),
    );

    if (!isSandbox(sandbox)) {
      throw new TypeError(
        `Sandbox definition "${registered.definition.logicalPath}" must return a durable Sandbox value.`,
      );
    }

    sandboxOwners.set(
      sandbox,
      sandboxOwners.get(sandbox) ?? {
        nodeId: input.nodeId,
        sessionId: input.sessionId,
      },
    );
    trackSandboxForShutdown(sandbox);
    return sandbox;
  }

  function trackSandboxForShutdown(sandbox: Sandbox): void {
    trackActiveSandboxHandle({
      provider: getSandboxAdapterType(sandbox),
      handle: {
        async shutdown() {
          await shutdownSandbox(sandbox);
        },
      },
      resourceId: sandbox.id,
    });
  }

  return {
    async captureState() {
      if (sandboxPromise === undefined) {
        return persistedState;
      }
      const sandbox = await sandboxPromise;
      const state: {
        owner: SandboxOwner;
        revision: string;
        root?: SandboxStateValue;
        value: Awaited<ReturnType<typeof serializeSandbox>>;
      } = {
        owner: sandboxOwners.get(sandbox) ?? {
          nodeId: input.nodeId,
          sessionId: input.sessionId,
        },
        revision,
        value: await serializeSandbox(sandbox),
      };
      if (input.rootState !== undefined) {
        state.root = input.rootState;
      }
      persistedState = state;
      return state;
    },
    async get() {
      return await getSandbox();
    },
  };
}

function restoreSandboxState(
  state: SandboxStateValue,
  input: {
    readonly appRoot: string;
    readonly signal: AbortSignal;
  },
): Sandbox {
  const sandbox = restoreSandbox(state.value, input);
  sandboxOwners.set(sandbox, state.owner);
  return sandbox;
}

function logDevelopmentSandbox(message: string): void {
  if (isEveDevEnvironment()) {
    console.log(message);
  }
}
