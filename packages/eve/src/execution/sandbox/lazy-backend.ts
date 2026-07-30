import type { SandboxBackend } from "#shared/sandbox-backend.js";

/**
 * Wraps a backend-producing function in a `SandboxBackend` proxy that
 * invokes the function exactly once, on first access to any of `.name`,
 * `.create`, or `.prewarm`. Subsequent accesses return the same cached
 * underlying backend.
 *
 * Used internally by `DefaultSandbox` so host availability is checked at
 * first use while preserving the selected engine's process-local state.
 */
export function lazyBackend<BO, SO>(factory: () => SandboxBackend<BO, SO>): SandboxBackend<BO, SO> {
  let resolved: SandboxBackend<BO, SO> | undefined;

  function resolve(): SandboxBackend<BO, SO> {
    if (resolved === undefined) {
      resolved = factory();
    }
    return resolved;
  }

  return {
    get name() {
      return resolve().name;
    },
    create(input) {
      return resolve().create(input);
    },
    prewarm(input) {
      return resolve().prewarm(input);
    },
  };
}
