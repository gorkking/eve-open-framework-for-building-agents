import { createHash } from "node:crypto";

import { createVercelSandbox } from "#execution/sandbox/bindings/vercel.js";
import { createBuiltinSandbox } from "#execution/sandbox/backend-sandbox.js";
import { createBuiltinSandboxTemplate } from "#execution/sandbox/builtin-template.js";
import type { Sandbox } from "#shared/sandbox-value.js";
import type { SandboxTemplate } from "#shared/sandbox-template.js";
import type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";

export type { VercelSandboxCreateOptions } from "#public/sandbox/vercel-sandbox.js";

/**
 * Build-time options for a Vercel Sandbox template.
 */
export type VercelSandboxTemplateOptions = VercelSandboxCreateOptions & {
  /**
   * Runs during template prewarm after eve hydrates the managed workspace.
   */
  readonly prepare?: (sandbox: Sandbox) => Promise<void> | void;
};

/**
 * Options for intentionally sharing a named Vercel Sandbox.
 */
export type VercelSandboxGetOrCreateOptions = VercelSandboxCreateOptions & {
  readonly name: string;
};

/**
 * A build-prewarmed Vercel Sandbox base.
 */
export interface VercelSandboxTemplate extends Omit<
  SandboxTemplate<VercelSandboxCreateOptions>,
  "create"
> {
  create(options?: VercelSandboxCreateOptions): Promise<Sandbox>;
  getOrCreate(options: VercelSandboxGetOrCreateOptions): Promise<Sandbox>;
}

type InternalVercelTemplateCreateOptions = VercelSandboxCreateOptions & {
  readonly __sessionKey?: string;
};

/**
 * Vercel Sandbox creation and build-prewarming.
 */
export const VercelSandbox = {
  /**
   * Creates the durable Vercel Sandbox returned by an authored definition.
   */
  async create(options: VercelSandboxCreateOptions = {}): Promise<Sandbox> {
    return await createBuiltinSandbox({
      backend: createVercelSandbox({ createOptions: options }),
      backendName: "vercel",
      templateKey: null,
    });
  },

  /**
   * Declares a reusable Vercel Sandbox base that eve prepares during build.
   */
  template(options: VercelSandboxTemplateOptions = {}): VercelSandboxTemplate {
    const { prepare, ...templateCreateOptions } = options;
    const template = createBuiltinSandboxTemplate<InternalVercelTemplateCreateOptions>({
      backendName: "vercel",
      createBackend(createOptions) {
        const { __sessionKey: _sessionKey, ...vercelOptions } = createOptions ?? {};
        return createVercelSandbox({
          createOptions: {
            ...templateCreateOptions,
            ...vercelOptions,
          } as VercelSandboxCreateOptions,
        });
      },
      prepare,
      revision: createVercelTemplateOptionsRevision(templateCreateOptions),
      sessionKey(createOptions) {
        return createOptions?.__sessionKey;
      },
      templateBackend: createVercelSandbox({ createOptions: templateCreateOptions }),
    });

    return Object.assign(template, {
      async getOrCreate({
        name,
        ...createOptions
      }: VercelSandboxGetOrCreateOptions): Promise<Sandbox> {
        return await template.create({
          ...createOptions,
          __sessionKey: name,
        });
      },
    }) as VercelSandboxTemplate;
  },
};

function createVercelTemplateOptionsRevision(options: VercelSandboxCreateOptions): string {
  return createHash("sha256").update(stableSerialize(options, new WeakSet())).digest("hex");
}

function stableSerialize(value: unknown, seen: WeakSet<object>): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? JSON.stringify(value) : JSON.stringify(String(value));
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return JSON.stringify(String(value));
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (typeof value === "function") {
    return `function:${value.toString()}`;
  }
  if (seen.has(value)) {
    throw new TypeError("VercelSandbox.template() options must not contain circular values.");
  }

  seen.add(value);
  const serialized = Array.isArray(value)
    ? `[${value.map((entry) => stableSerialize(entry, seen)).join(",")}]`
    : `{${Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry, seen)}`)
        .join(",")}}`;
  seen.delete(value);
  return serialized;
}
