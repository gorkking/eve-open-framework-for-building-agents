import type { MemoryScopeContext } from "#public/memory/index.js";

/** Scopes memory to the authenticated caller; unauthenticated turns disable the slot. */
export function byPrincipal(context: MemoryScopeContext): string | null {
  const principal = context.session.auth.current;
  if (principal === null) return null;
  return JSON.stringify([
    principal.principalType,
    principal.authenticator,
    principal.issuer ?? null,
    principal.principalId,
  ]);
}
