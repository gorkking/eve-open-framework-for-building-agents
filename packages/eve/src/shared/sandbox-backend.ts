import type { JsonObject } from "#shared/json.js";
import type { SandboxSession } from "#shared/sandbox-session.js";

/**
 * Internal option application function retained by the built-in backend
 * bridge while providers migrate to durable Sandbox values.
 */
export type SandboxBackendUseFn<O = Record<string, never>> = (
  options?: O,
) => Promise<SandboxSession>;

/**
 * Internal template-preparation context for built-in backends.
 */
export interface SandboxBackendPrewarmContext<O = Record<string, never>> {
  readonly use: SandboxBackendUseFn<O>;
}

/**
 * Internal live handle retained by the built-in backend bridge.
 */
export interface SandboxBackendHandle<SO = Record<string, never>> {
  readonly session: SandboxSession;
  readonly useSessionFn: SandboxBackendUseFn<SO>;
  captureState(): Promise<SandboxBackendSessionState>;
  /**
   * Stops the underlying compute because the eve server is shutting
   * down; nothing may be left running afterwards. The session must
   * remain reattachable from persisted state on the next server start
   * when the backend supports durable sessions.
   */
  shutdown(): Promise<void>;
}

/**
 * Serializable per-sandbox reconnect record stored on the harness session.
 *
 * `backendName` matches the {@link SandboxBackend.name} of the backend
 * that produced this state. The runtime reads it to decide whether a
 * previously persisted handle is still compatible with the current
 * backend.
 */
export interface SandboxBackendSessionState {
  readonly backendName: string;
  readonly metadata: Record<string, unknown>;
  readonly sessionKey: string;
}

/**
 * One file written into a sandbox template before template state capture.
 */
export interface SandboxSeedFile {
  readonly path: string;
  readonly content: string | Buffer;
}

/**
 * Diagnostic tags attached to provider-owned sandbox resources.
 *
 * Built-in backends may forward these into their hosting platform's
 * native tagging system. eve supplies stable tags such as the active
 * agent, channel, and session id so sandboxes can be found and
 * attributed in provider dashboards.
 */
export type SandboxBackendTags = Readonly<Record<string, string>>;

/**
 * Framework-owned runtime context handed to a backend on every
 * {@link SandboxBackend.create} call.
 *
 * Backends use this to derive any per-call state that depends on the
 * surrounding application. For example, the local backend computes its
 * cache directory from `appRoot`. Backends that don't need anything
 * here may ignore the field entirely.
 */
export interface SandboxBackendRuntimeContext {
  readonly appRoot: string;
}

/**
 * Input passed to {@link SandboxBackend.create} when the runtime needs a
 * live sandbox session.
 */
export interface SandboxBackendCreateInput {
  /**
   * Reusable template key to open this session from. `null` means eve
   * intentionally skipped template prewarm because the sandbox has no
   * `bootstrap()` and no seed files, so the backend should create a
   * fresh session from its default base runtime.
   */
  readonly templateKey: string | null;
  /**
   * Exact provider result captured while prewarming `templateKey`.
   */
  readonly templateReference?: JsonObject;
  readonly sessionKey: string;
  readonly signal?: AbortSignal;
  readonly existingMetadata?: Record<string, unknown>;
  /**
   * Runtime tags the backend should attach to sandbox resources when
   * the underlying provider supports tags.
   */
  readonly tags?: SandboxBackendTags;
  readonly runtimeContext: SandboxBackendRuntimeContext;
}

/**
 * Input passed to {@link SandboxBackend.prewarm} when the build pipeline
 * is preparing reusable templates.
 *
 * Each exported built-in template receives one `prewarm(...)` call. The
 * bridge captures reusable state from the supplied preparation callback and
 * seed files, then opens durable sessions from that state.
 */
export interface SandboxBackendPrewarmInput<BO = Record<string, never>> {
  readonly templateKey: string;
  readonly bootstrap?: (input: SandboxBackendPrewarmContext<BO>) => void | Promise<void>;
  /**
   * Optional progress logger for backend-specific prewarm phases.
   */
  readonly log?: (message: string) => void;
  readonly runtimeContext: SandboxBackendRuntimeContext;
  readonly seedFiles: ReadonlyArray<SandboxSeedFile>;
}

/**
 * Outcome of one {@link SandboxBackend.prewarm} call.
 *
 * The build pipeline uses this to report in the build logs whether a
 * template state was reused from a prior deploy or captured fresh, so
 * a cache hit is distinguishable from an expensive rebuild.
 */
export interface SandboxBackendPrewarmResult {
  /**
   * `true` when existing template state was reused without rebuilding it;
   * `false` when the backend captured fresh template state.
   */
  readonly reused: boolean;
  /**
   * Opaque provider reference frozen into the deployment for runtime create.
   */
  readonly templateReference?: JsonObject;
}

/**
 * Internal bridge protocol used by eve's existing built-in engines.
 *
 * Custom providers implement `defineSandboxAdapter()` and optionally
 * `defineSandboxTemplate()` instead of implementing this interface.
 */
export interface SandboxBackend<BO = Record<string, never>, SO = Record<string, never>> {
  /**
   * Stable identifier for this backend implementation.
   *
   * Participates in cache-key derivation and the persisted reconnect
   * state, so two backends that should not share template state
   * must use distinct names. Built-in backends use `"vercel"` and
   * `"local"`. Custom backends pick a unique string.
   */
  readonly name: string;
  /**
   * Creates or reattaches one live sandbox session from a template
   * previously captured by {@link SandboxBackend.prewarm}. Throws
   * {@link SandboxTemplateNotProvisionedError} when the requested
   * template is missing.
   */
  create(input: SandboxBackendCreateInput): Promise<SandboxBackendHandle<SO>>;
  /**
   * Build-time prewarm hook. eve invokes this for every authored
   * sandbox in the compiled graph before serving traffic so the backend
   * can capture reusable template state. Idempotent against existing state
   * keyed by `templateKey`.
   *
   * Returns whether the state was reused from a prior run or captured
   * fresh so the build pipeline can surface that in its logs.
   */
  prewarm(input: SandboxBackendPrewarmInput<BO>): Promise<SandboxBackendPrewarmResult>;
}

/**
 * Internal signal that a built-in template must be prepared before retrying
 * sandbox creation.
 */
export class SandboxTemplateNotProvisionedError extends Error {
  readonly backendName: string;
  readonly templateKey: string;

  constructor(input: { readonly backendName: string; readonly templateKey: string }) {
    super(
      `Sandbox template "${input.templateKey}" is not provisioned for backend "${input.backendName}". Run \`eve build\` before serving traffic.`,
    );
    this.name = "SandboxTemplateNotProvisionedError";
    this.backendName = input.backendName;
    this.templateKey = input.templateKey;
  }

  static is(error: unknown): error is SandboxTemplateNotProvisionedError {
    return (
      error instanceof SandboxTemplateNotProvisionedError ||
      (typeof error === "object" &&
        error !== null &&
        (error as { readonly name?: unknown }).name === "SandboxTemplateNotProvisionedError" &&
        typeof (error as { readonly backendName?: unknown }).backendName === "string" &&
        typeof (error as { readonly templateKey?: unknown }).templateKey === "string")
    );
  }
}
