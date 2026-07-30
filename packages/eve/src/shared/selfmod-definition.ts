const SELF_MODIFYING_SANDBOX = Symbol.for("eve.selfmod-sandbox");

/** Stable name of the framework-owned selfmod sandbox backend. */
export const SELFMOD_SANDBOX_BACKEND_NAME = "eve-selfmod";

interface SelfModifyingSandboxCarrier {
  readonly [SELF_MODIFYING_SANDBOX]?: unknown;
}

/** Attaches the runtime sandbox hidden from authored configuration. */
export function attachSelfModifyingSandboxDefinition(target: object, sandbox: unknown): void {
  Object.defineProperty(target, SELF_MODIFYING_SANDBOX, { value: sandbox });
}

/** Extracts the sandbox carried by a selfmod declaration module. */
export function readSelfModifyingSandboxDefinition(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  return (value as SelfModifyingSandboxCarrier)[SELF_MODIFYING_SANDBOX] ?? value;
}
