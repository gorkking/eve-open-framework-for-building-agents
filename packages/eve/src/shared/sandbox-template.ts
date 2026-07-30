import { createHash } from "node:crypto";

import { contextStorage } from "#context/container.js";
import { SandboxTemplateBindingsKey } from "#context/keys.js";
import { withVirtualContextValue } from "#context/virtual-scope.js";
import { parseJsonValue, type JsonValue } from "#shared/json.js";
import type { Sandbox } from "#shared/sandbox-value.js";

const SANDBOX_TEMPLATE = Symbol.for("eve.sandbox-template");
const SANDBOX_TEMPLATE_REFERENCES = Symbol.for("eve.sandbox-template-references");

type SandboxTemplateGlobal = typeof globalThis & {
  [SANDBOX_TEMPLATE_REFERENCES]?: Map<string, unknown>;
};

/**
 * Build assets discovered beside an exported sandbox template.
 */
export interface SandboxTemplateAssets {
  readonly dockerfile?: {
    readonly contextPath: string;
    readonly path: string;
  };
}

/**
 * Input passed to a provider's build-time template implementation.
 *
 * The app author supplies only template options such as `prepare`. eve
 * supplies the build identity, application root, assets, hydration, and log
 * sink directly to the provider implementation.
 */
export interface SandboxTemplatePrewarmInput {
  readonly appRoot: string;
  readonly assets: SandboxTemplateAssets;
  hydrate(sandbox: Sandbox): Promise<void>;
  readonly log?: (message: string) => void;
  readonly templateId: string;
}

/**
 * Provider implementation behind one exported sandbox template.
 */
export interface SandboxTemplateDefinition<Reference extends JsonValue, CreateOptions> {
  /**
   * Provider-owned inputs that affect the prewarmed base.
   *
   * eve hashes this value into its private template identity. App authors do
   * not supply cache or revalidation keys.
   */
  readonly revision?: JsonValue;
  /**
   * Produces the provider reference frozen into the deployment.
   */
  prewarm(input: SandboxTemplatePrewarmInput): Promise<Reference>;
  /**
   * Creates a durable sandbox from the frozen provider reference.
   */
  create(input: {
    readonly options: CreateOptions;
    readonly reference: Reference;
  }): Sandbox | Promise<Sandbox>;
}

/**
 * A provider-owned base that eve can prepare during build.
 */
export interface SandboxTemplate<CreateOptions = Record<string, never>> {
  /**
   * Creates a durable sandbox from this build-prewarmed base.
   */
  create(options: CreateOptions): Promise<Sandbox>;
}

export interface InternalSandboxTemplate {
  readonly implementationId: string;
  prewarm(input: SandboxTemplatePrewarmInput): Promise<unknown>;
}

type SandboxTemplateWithInternal<CreateOptions> = SandboxTemplate<CreateOptions> & {
  readonly [SANDBOX_TEMPLATE]: InternalSandboxTemplate;
};

/**
 * Defines the provider lifecycle behind a build-prewarmed template.
 *
 * Runtime references are scoped to the active sandbox definition invocation;
 * the template object is never mutated or process-globally bound.
 */
export function defineSandboxTemplate<
  Reference extends JsonValue,
  CreateOptions = Record<string, never>,
>(definition: SandboxTemplateDefinition<Reference, CreateOptions>): SandboxTemplate<CreateOptions> {
  const implementationId = `template-${stableHash(
    stableJsonStringify(parseJsonValue(definition.revision ?? null)),
  )}`;
  let internal: InternalSandboxTemplate;

  const template: SandboxTemplateWithInternal<CreateOptions> = {
    async create(options) {
      const reference = readActiveSandboxTemplateReference(internal);
      if (reference === undefined) {
        throw new Error(
          "Sandbox template has no prewarmed build result. Export it from the sandbox module and run eve build.",
        );
      }
      return await definition.create({
        options,
        reference: parseJsonValue(reference) as Reference,
      });
    },
    [SANDBOX_TEMPLATE]: (internal = {
      implementationId,
      async prewarm(input) {
        return await definition.prewarm(input);
      },
    }),
  };

  return template;
}

/**
 * Returns whether a module export is a build-prewarmable sandbox template.
 */
export function isSandboxTemplate(value: unknown): value is SandboxTemplate {
  return typeof value === "object" && value !== null && SANDBOX_TEMPLATE in value;
}

/**
 * Reads the framework-owned template lifecycle.
 */
export function getSandboxTemplateInternal<CreateOptions>(
  template: SandboxTemplate<CreateOptions>,
): InternalSandboxTemplate {
  if (!isSandboxTemplate(template)) {
    throw new TypeError("Expected a SandboxTemplate value.");
  }
  return (template as SandboxTemplateWithInternal<unknown>)[SANDBOX_TEMPLATE];
}

/**
 * Runs one sandbox definition with its exact exported template references.
 */
export async function withSandboxTemplateBindings<T>(
  bindings: ReadonlyMap<InternalSandboxTemplate, unknown>,
  callback: () => T | Promise<T>,
): Promise<T> {
  return await withVirtualContextValue(SandboxTemplateBindingsKey, bindings, callback);
}

/**
 * Records a prewarm result for runtime binding in the current process.
 */
export function recordSandboxTemplateReference(templateKey: string, reference: unknown): void {
  getSandboxTemplateReferences().set(templateKey, reference);
}

/**
 * Reads a prewarm result captured in the current process.
 */
export function readSandboxTemplateReference(templateKey: string): unknown {
  return getSandboxTemplateReferences().get(templateKey);
}

/**
 * Returns whether the current process captured a reference for a template.
 */
export function hasSandboxTemplateReference(templateKey: string): boolean {
  return getSandboxTemplateReferences().has(templateKey);
}

function readActiveSandboxTemplateReference(
  template: InternalSandboxTemplate,
): unknown | undefined {
  return contextStorage.getStore()?.get(SandboxTemplateBindingsKey)?.get(template);
}

function getSandboxTemplateReferences(): Map<string, unknown> {
  const container = globalThis as SandboxTemplateGlobal;
  container[SANDBOX_TEMPLATE_REFERENCES] ??= new Map();
  return container[SANDBOX_TEMPLATE_REFERENCES];
}

function stableHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function stableJsonStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJsonStringify).join(",")}]`;
  }
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJsonStringify(entry)}`)
    .join(",")}}`;
}
