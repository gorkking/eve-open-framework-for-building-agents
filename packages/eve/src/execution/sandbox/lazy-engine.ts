import type { SandboxEngine } from "#shared/sandbox-engine.js";

/**
 * Wraps a provider-producing function in a `SandboxEngine` proxy that
 * invokes the function exactly once, on first access to any of `.provider`,
 * `.create`, or `.prepare`. Subsequent accesses return the same cached
 * underlying provider.
 *
 * Used internally by `DefaultSandbox` so host availability is checked at
 * first use while preserving the selected engine's process-local state.
 */
export function lazyEngine(factory: () => SandboxEngine): SandboxEngine {
  let resolved: SandboxEngine | undefined;

  function resolve(): SandboxEngine {
    if (resolved === undefined) {
      resolved = factory();
    }
    return resolved;
  }

  return {
    get provider() {
      return resolve().provider;
    },
    create(input) {
      return resolve().create(input);
    },
    prepare(input) {
      return resolve().prepare(input);
    },
  };
}
