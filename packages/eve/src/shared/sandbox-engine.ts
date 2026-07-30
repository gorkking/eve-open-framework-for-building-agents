import type { JsonObject } from "#shared/json.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

/**
 * Live provider resource returned by a built-in sandbox engine.
 */
export interface SandboxEngineHandle {
  readonly session: SandboxSession;
  captureState(): Promise<SandboxEngineState>;
  /**
   * Stops process-local or remote compute without deleting durable state.
   */
  shutdown(): Promise<void>;
}

/**
 * Serializable provider state needed to reconnect to one sandbox.
 */
export interface SandboxEngineState {
  readonly configuration: JsonObject;
  readonly metadata: JsonObject;
  readonly provider: string;
  readonly sessionKey: string;
}

/**
 * One managed-workspace file hydrated before template preparation.
 */
export interface SandboxSeedFile {
  readonly path: string;
  readonly content: string | Buffer;
}

/**
 * Diagnostic tags attached to provider-owned sandbox resources.
 */
export type SandboxResourceTags = Readonly<Record<string, string>>;

/**
 * Framework context needed by local provider engines.
 */
export interface SandboxEngineContext {
  readonly appRoot: string;
}

/**
 * Runtime creation input for a built-in provider engine.
 */
export interface SandboxEngineCreateInput {
  readonly existingMetadata?: JsonObject;
  readonly context: SandboxEngineContext;
  readonly sessionKey: string;
  readonly signal?: AbortSignal;
  readonly tags?: SandboxResourceTags;
  readonly templateKey: string | null;
  readonly templateReference?: JsonObject;
}

/**
 * Build-time preparation input for a built-in provider engine.
 */
export interface SandboxEnginePrepareInput {
  readonly context: SandboxEngineContext;
  readonly log?: (message: string) => void;
  readonly prepare?: (sandbox: SandboxSession) => void | Promise<void>;
  readonly seedFiles: ReadonlyArray<SandboxSeedFile>;
  readonly templateKey: string;
}

/**
 * Exact provider result captured during template preparation.
 */
export interface SandboxEnginePrepareResult {
  readonly reference?: JsonObject;
  readonly reused: boolean;
}

/**
 * Internal provider engine used by eve's built-in sandbox integrations.
 *
 * App and third-party provider authors use durable `Sandbox` values,
 * `defineSandboxAdapter()`, and `defineSandboxTemplate()` instead.
 */
export interface SandboxEngine {
  readonly provider: string;
  create(input: SandboxEngineCreateInput): Promise<SandboxEngineHandle>;
  prepare(input: SandboxEnginePrepareInput): Promise<SandboxEnginePrepareResult>;
}

/**
 * Signals that a provider template reference can no longer be opened.
 */
export class SandboxTemplateUnavailableError extends Error {
  readonly provider: string;
  readonly templateKey: string;

  constructor(input: { readonly provider: string; readonly templateKey: string }) {
    super(
      `Sandbox template "${input.templateKey}" is unavailable from provider "${input.provider}". Run \`eve build\` before serving traffic.`,
    );
    this.name = "SandboxTemplateUnavailableError";
    this.provider = input.provider;
    this.templateKey = input.templateKey;
  }

  static is(error: unknown): error is SandboxTemplateUnavailableError {
    return (
      error instanceof SandboxTemplateUnavailableError ||
      (typeof error === "object" &&
        error !== null &&
        (error as { readonly name?: unknown }).name === "SandboxTemplateUnavailableError" &&
        typeof (error as { readonly provider?: unknown }).provider === "string" &&
        typeof (error as { readonly templateKey?: unknown }).templateKey === "string")
    );
  }
}

/**
 * Signals that a persisted sandbox resource can no longer be restored.
 */
export class SandboxResourceUnavailableError extends Error {
  readonly provider: string;
  readonly sessionKey: string;

  constructor(input: { readonly provider: string; readonly sessionKey: string }) {
    super(
      `Persisted sandbox "${input.sessionKey}" is unavailable from provider "${input.provider}".`,
    );
    this.name = "SandboxResourceUnavailableError";
    this.provider = input.provider;
    this.sessionKey = input.sessionKey;
  }

  static is(error: unknown): error is SandboxResourceUnavailableError {
    return (
      error instanceof SandboxResourceUnavailableError ||
      (typeof error === "object" &&
        error !== null &&
        (error as { readonly name?: unknown }).name === "SandboxResourceUnavailableError" &&
        typeof (error as { readonly provider?: unknown }).provider === "string" &&
        typeof (error as { readonly sessionKey?: unknown }).sessionKey === "string")
    );
  }
}
