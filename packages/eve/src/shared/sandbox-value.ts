import { contextStorage } from "#context/container.js";
import { SandboxProviderContextKey } from "#context/keys.js";
import { withVirtualContextValue } from "#context/virtual-scope.js";
import type { JsonValue } from "#shared/json.js";
import { parseJsonValue } from "#shared/json.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const SANDBOX_VALUE = Symbol.for("eve.sandbox-value");
const SANDBOX_ADAPTERS = Symbol.for("eve.sandbox-adapters");

type RegisteredSandboxAdapter = SandboxAdapterDefinition<unknown, JsonValue>;
type SandboxAdapterRegistry = Map<string, RegisteredSandboxAdapter>;

type SandboxValueGlobal = typeof globalThis & {
  [SANDBOX_ADAPTERS]?: SandboxAdapterRegistry;
};

/**
 * A durable sandbox returned by an authored sandbox definition.
 *
 * The filesystem and process methods are the same as {@link SandboxSession}.
 * Durability is implemented by the sandbox provider and remains invisible to
 * app code.
 */
export interface Sandbox extends SandboxSession {}

/**
 * Framework context supplied to a provider while it creates or restores a
 * sandbox.
 *
 * App sandbox definitions do not construct or forward this context. The
 * adapter returned by {@link defineSandboxAdapter} supplies it to provider
 * implementation code.
 */
export interface SandboxProviderContext {
  /** Absolute application root for providers that manage local resources. */
  readonly appRoot: string;
  /** Stable eve-owned identity for this durable sandbox resource. */
  readonly resourceId: string;
  /** Cancellation signal for the active sandbox access. */
  readonly signal: AbortSignal;
  /** Framework resource tags, when the active channel supplies them. */
  readonly tags?: Readonly<Record<string, string>>;
}

/**
 * Serializable provider reference persisted with an eve session.
 */
export interface SerializedSandbox {
  readonly adapterId: string;
  readonly id: string;
  readonly reference: JsonValue;
  readonly resourceId: string;
}

/**
 * Provider contract used by {@link defineSandboxAdapter}.
 */
export interface SandboxAdapterDefinition<RawSandbox, Reference extends JsonValue> {
  /**
   * Stable protocol discriminator owned by the provider implementation.
   *
   * App sandbox definitions never see or supply this value.
   */
  readonly type: string;
  /**
   * Captures the provider reference needed to restore this sandbox later.
   *
   * The reference must identify stable provider state. If capturing a mutable
   * checkpoint replaces an older checkpoint, the provider must keep that
   * replacement behind the same durable identity so parent and child sessions
   * holding an earlier serialized value still restore the current sandbox.
   */
  reference(sandbox: RawSandbox): Reference | Promise<Reference>;
  /**
   * Reconnects to a previously captured provider reference.
   */
  restore(reference: Reference, context: SandboxProviderContext): RawSandbox | Promise<RawSandbox>;
  /**
   * Projects the provider handle onto eve's filesystem and process surface.
   */
  session(sandbox: RawSandbox): SandboxSession;
  /**
   * Stops process-local compute during server shutdown without deleting
   * durable provider state.
   */
  shutdown?(sandbox: RawSandbox): void | Promise<void>;
}

/**
 * Provider adapter returned by {@link defineSandboxAdapter}.
 */
export interface SandboxAdapter<RawSandbox> {
  /**
   * Adapts an existing provider handle using the active sandbox resource
   * context.
   */
  (sandbox: RawSandbox): Sandbox;
  /**
   * Creates and adapts a provider handle with eve's stable resource identity,
   * cancellation signal, application root, and resource tags.
   */
  create(
    factory: (context: SandboxProviderContext) => RawSandbox | Promise<RawSandbox>,
  ): Promise<Sandbox>;
}

interface SandboxValueInternal {
  readonly adapterId: string;
  serialize(): Promise<SerializedSandbox>;
  shutdown(): Promise<void>;
}

type InternalSandbox = Sandbox & {
  readonly [SANDBOX_VALUE]: SandboxValueInternal;
};

/**
 * Defines the durable boundary for a provider-native sandbox.
 *
 * Provider implementations normally call `adapter.create((context) => raw)`
 * from their public creation methods. This keeps eve-owned resource identity
 * and runtime context out of app sandbox definitions. The callable adapter is
 * available for provider handles obtained by another provider-native method.
 */
export function defineSandboxAdapter<RawSandbox, Reference extends JsonValue>(
  definition: SandboxAdapterDefinition<RawSandbox, Reference>,
): SandboxAdapter<RawSandbox> {
  const adapterId = expectSandboxAdapterType(definition.type);
  const adapter = registerSandboxAdapter(adapterId, definition);

  function adapt(sandbox: RawSandbox, context = readSandboxProviderContext()): Sandbox {
    const session = definition.session(sandbox);
    return createSandboxValue({
      adapter,
      adapterId,
      id: session.id,
      providerContext: context ?? createFallbackProviderContext(session.id),
      rawSandbox: Promise.resolve(sandbox),
      session: Promise.resolve(session),
    });
  }

  return Object.assign((sandbox: RawSandbox) => adapt(sandbox), {
    async create(
      factory: (context: SandboxProviderContext) => RawSandbox | Promise<RawSandbox>,
    ): Promise<Sandbox> {
      const context = requireSandboxProviderContext();
      return adapt(await factory(context), context);
    },
  });
}

/**
 * Returns whether a value is a durable eve sandbox.
 */
export function isSandbox(value: unknown): value is Sandbox {
  return (
    typeof value === "object" &&
    value !== null &&
    SANDBOX_VALUE in value &&
    typeof (value as Partial<InternalSandbox>)[SANDBOX_VALUE]?.serialize === "function"
  );
}

/**
 * Captures the provider-owned durable reference for a sandbox.
 */
export async function serializeSandbox(sandbox: Sandbox): Promise<SerializedSandbox> {
  return getSandboxInternal(sandbox).serialize();
}

/**
 * Restores a lazy sandbox handle from persisted provider state.
 */
export function restoreSandbox(
  serialized: SerializedSandbox,
  input: {
    readonly appRoot?: string;
    readonly signal?: AbortSignal;
    readonly tags?: Readonly<Record<string, string>>;
  } = {},
): Sandbox {
  const adapter = getSandboxAdapter(serialized.adapterId);
  const providerContext: SandboxProviderContext = {
    appRoot: input.appRoot ?? process.cwd(),
    resourceId: serialized.resourceId,
    signal: input.signal ?? new AbortController().signal,
    tags: input.tags,
  };
  return createSandboxValue({
    adapter,
    adapterId: serialized.adapterId,
    id: serialized.id,
    providerContext,
    rawSandbox: Promise.resolve().then(
      async () => await adapter.restore(serialized.reference, providerContext),
    ),
  });
}

/**
 * Stops the process-local compute behind a sandbox.
 */
export async function shutdownSandbox(sandbox: Sandbox): Promise<void> {
  await getSandboxInternal(sandbox).shutdown();
}

/**
 * Reads the provider-owned protocol discriminator for process-local tracking.
 */
export function getSandboxAdapterType(sandbox: Sandbox): string {
  return getSandboxInternal(sandbox).adapterId;
}

/**
 * Runs provider creation inside one framework-owned sandbox resource context.
 *
 * Internal lifecycle primitive; app definitions receive the simpler
 * `SandboxDefinitionContext` instead.
 */
export async function withSandboxProviderContext<T>(
  context: SandboxProviderContext,
  callback: () => T | Promise<T>,
): Promise<T> {
  return await withVirtualContextValue(SandboxProviderContextKey, context, callback);
}

function createSandboxValue(input: {
  readonly adapter: RegisteredSandboxAdapter;
  readonly adapterId: string;
  readonly id: string;
  readonly providerContext: SandboxProviderContext;
  readonly rawSandbox: Promise<unknown>;
  readonly session?: Promise<SandboxSession>;
}): Sandbox {
  let sessionPromise = input.session;
  let shutdownPromise: Promise<void> | undefined;

  function session(): Promise<SandboxSession> {
    sessionPromise ??= input.rawSandbox.then((rawSandbox) => input.adapter.session(rawSandbox));
    return sessionPromise;
  }

  const sandbox: InternalSandbox = {
    id: input.id,
    resolvePath(path) {
      // A restored provider handle may be lazy, while path resolution is
      // synchronous. Every eve sandbox anchors relative paths identically.
      if (path.startsWith("/")) {
        return path;
      }
      return `/workspace/${path.replace(/^\.?\//, "")}`;
    },
    async readFile(options) {
      return await (await session()).readFile(options);
    },
    async readBinaryFile(options) {
      return await (await session()).readBinaryFile(options);
    },
    async readTextFile(options) {
      return await (await session()).readTextFile(options);
    },
    async removePath(options) {
      await (await session()).removePath(options);
    },
    async run(options) {
      return await (await session()).run(options);
    },
    async setNetworkPolicy(policy) {
      await (await session()).setNetworkPolicy(policy);
    },
    async spawn(options) {
      return await (await session()).spawn(options);
    },
    async writeFile(options) {
      await (await session()).writeFile(options);
    },
    async writeBinaryFile(options) {
      await (await session()).writeBinaryFile(options);
    },
    async writeTextFile(options) {
      await (await session()).writeTextFile(options);
    },
    [SANDBOX_VALUE]: {
      adapterId: input.adapterId,
      async serialize() {
        const rawSandbox = await input.rawSandbox;
        return {
          adapterId: input.adapterId,
          id: input.id,
          reference: parseJsonValue(await input.adapter.reference(rawSandbox)),
          resourceId: input.providerContext.resourceId,
        };
      },
      async shutdown() {
        if (input.adapter.shutdown === undefined) {
          return;
        }
        shutdownPromise ??= input.rawSandbox.then(async (rawSandbox) => {
          await input.adapter.shutdown?.(rawSandbox);
        });
        await shutdownPromise;
      },
    },
  };

  return sandbox;
}

function getSandboxInternal(sandbox: Sandbox): SandboxValueInternal {
  if (!isSandbox(sandbox)) {
    throw new TypeError("Expected a durable Sandbox value.");
  }
  return (sandbox as InternalSandbox)[SANDBOX_VALUE];
}

function registerSandboxAdapter<RawSandbox, Reference extends JsonValue>(
  adapterId: string,
  definition: SandboxAdapterDefinition<RawSandbox, Reference>,
): RegisteredSandboxAdapter {
  const adapter: RegisteredSandboxAdapter = {
    type: adapterId,
    reference(sandbox) {
      return definition.reference(sandbox as RawSandbox);
    },
    restore(reference, context) {
      return definition.restore(reference as Reference, context);
    },
    session(sandbox) {
      return definition.session(sandbox as RawSandbox);
    },
    shutdown:
      definition.shutdown === undefined
        ? undefined
        : (sandbox) => definition.shutdown?.(sandbox as RawSandbox),
  };
  getSandboxAdapterRegistry().set(adapterId, adapter);
  return adapter;
}

function getSandboxAdapter(adapterId: string): RegisteredSandboxAdapter {
  const adapter = getSandboxAdapterRegistry().get(adapterId);
  if (adapter === undefined) {
    throw new Error(
      `Cannot restore sandbox "${adapterId}" because its provider adapter is not registered.`,
    );
  }
  return adapter;
}

function getSandboxAdapterRegistry(): SandboxAdapterRegistry {
  const container = globalThis as SandboxValueGlobal;
  container[SANDBOX_ADAPTERS] ??= new Map();
  return container[SANDBOX_ADAPTERS];
}

function readSandboxProviderContext(): SandboxProviderContext | undefined {
  return contextStorage.getStore()?.get(SandboxProviderContextKey);
}

function requireSandboxProviderContext(): SandboxProviderContext {
  const context = readSandboxProviderContext();
  if (context === undefined) {
    throw new Error(
      "Sandbox provider creation requires an active sandbox definition. " +
        "Call the provider from defineSandbox((ctx) => sandbox).",
    );
  }
  return context;
}

function createFallbackProviderContext(resourceId: string): SandboxProviderContext {
  return {
    appRoot: process.cwd(),
    resourceId,
    signal: new AbortController().signal,
  };
}

function expectSandboxAdapterType(type: string): string {
  if (type.trim() === "") {
    throw new TypeError("Sandbox adapter type must be a non-empty provider protocol name.");
  }
  return type;
}
