import type { MemoryScopeContext } from "#public/memory/index.js";

const DISABLED_PRINCIPAL_TYPES = new Set(["anonymous", "runtime"]);

/**
 * Scopes memory to the authenticated caller. Returns `null` — disabling the
 * slot — for unauthenticated turns, anonymous principals such as `none()`
 * traffic, and runtime principals such as scheduled turns.
 */
export function byPrincipal(context: MemoryScopeContext): string | null {
  const principal = context.session.auth.current;
  if (principal === null) return null;
  if (DISABLED_PRINCIPAL_TYPES.has(principal.principalType)) return null;
  return JSON.stringify([
    principal.principalType,
    principal.authenticator,
    principal.issuer ?? null,
    principal.principalId,
  ]);
}
