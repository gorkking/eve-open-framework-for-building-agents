import { createHash } from "node:crypto";

import type { JsonValue } from "#shared/json.js";
import { parseJsonValue } from "#shared/json.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

const SANDBOX_VALUE = Symbol.for("eve.sandbox-value");
const SANDBOX_ADAPTERS = Symbol.for("eve.sandbox-adapters");

type SandboxAdapterRegistry = Map<string, SandboxAdapterDefinition<unknown, JsonValue>>;

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
 * Serializable provider reference persisted with an eve session.
 */
export interface SerializedSandbox {
  readonly adapterId: string;
  readonly id: string;
  readonly reference: JsonValue;
}

/**
 * Provider contract used by {@link defineSandboxAdapter}.
 */
export interface SandboxAdapterDefinition<RawSandbox, Reference extends JsonValue> {
  /**
   * Captures the provider reference needed to restore this sandbox later.
   */
  reference(sandbox: RawSandbox): Reference | Promise<Reference>;
  /**
   * Reconnects to a previously captured provider reference.
   */
  restore(reference: Reference): RawSandbox | Promise<RawSandbox>;
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

interface SandboxValueInternal {
  serialize(): Promise<SerializedSandbox>;
  shutdown(): Promise<void>;
}

type InternalSandbox = Sandbox & {
  readonly [SANDBOX_VALUE]: SandboxValueInternal;
};

/**
 * Adapts a provider-native handle into a durable {@link Sandbox}.
 *
 * The returned adapter function is normally created once at module scope by a
 * provider package. Its implementation identity is derived internally; app
 * authors do not provide persistence keys.
 */
export function defineSandboxAdapter<RawSandbox, Reference extends JsonValue>(
  definition: SandboxAdapterDefinition<RawSandbox, Reference>,
): (sandbox: RawSandbox) => Sandbox {
  const adapterId = createSandboxAdapterId(definition);
  registerSandboxAdapter(adapterId, definition);

  return (sandbox) =>
    createSandboxValue({
      adapterId,
      id: definition.session(sandbox).id,
      rawSandbox: Promise.resolve(sandbox),
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
export function restoreSandbox(serialized: SerializedSandbox): Sandbox {
  const adapter = getSandboxAdapter(serialized.adapterId);
  return createSandboxValue({
    adapterId: serialized.adapterId,
    id: serialized.id,
    rawSandbox: Promise.resolve().then(async () => await adapter.restore(serialized.reference)),
  });
}

/**
 * Stops the process-local compute behind a sandbox.
 */
export async function shutdownSandbox(sandbox: Sandbox): Promise<void> {
  await getSandboxInternal(sandbox).shutdown();
}

function createSandboxValue(input: {
  readonly adapterId: string;
  readonly id: string;
  readonly rawSandbox: Promise<unknown>;
}): Sandbox {
  const adapter = getSandboxAdapter(input.adapterId);
  let sessionPromise: Promise<SandboxSession> | undefined;
  let shutdownPromise: Promise<void> | undefined;

  function session(): Promise<SandboxSession> {
    sessionPromise ??= input.rawSandbox.then((rawSandbox) => adapter.session(rawSandbox));
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
      async serialize() {
        const rawSandbox = await input.rawSandbox;
        return {
          adapterId: input.adapterId,
          id: input.id,
          reference: parseJsonValue(await adapter.reference(rawSandbox)),
        };
      },
      async shutdown() {
        if (adapter.shutdown === undefined) {
          return;
        }
        shutdownPromise ??= input.rawSandbox.then(async (rawSandbox) => {
          await adapter.shutdown?.(rawSandbox);
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
): void {
  getSandboxAdapterRegistry().set(adapterId, {
    reference(sandbox) {
      return definition.reference(sandbox as RawSandbox);
    },
    restore(reference) {
      return definition.restore(reference as Reference);
    },
    session(sandbox) {
      return definition.session(sandbox as RawSandbox);
    },
    shutdown:
      definition.shutdown === undefined
        ? undefined
        : (sandbox) => definition.shutdown?.(sandbox as RawSandbox),
  });
}

function getSandboxAdapter(adapterId: string): SandboxAdapterDefinition<unknown, JsonValue> {
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

function createSandboxAdapterId<RawSandbox, Reference extends JsonValue>(
  definition: SandboxAdapterDefinition<RawSandbox, Reference>,
): string {
  const source = [
    definition.reference.toString(),
    definition.restore.toString(),
    definition.session.toString(),
    definition.shutdown?.toString() ?? "",
  ].join("\n");
  return `sandbox-${createHash("sha256").update(source).digest("hex").slice(0, 32)}`;
}
