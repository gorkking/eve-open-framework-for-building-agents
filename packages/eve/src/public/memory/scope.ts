import { buildCallbackContext } from "#context/build-callback-context.js";

/** Scopes memory to the authenticated caller; unauthenticated turns disable the slot. */
export function byPrincipal(): string | null {
  const principal = buildCallbackContext().session.auth.current;
  if (principal === null) return null;
  return JSON.stringify([
    principal.principalType,
    principal.authenticator,
    principal.issuer ?? null,
    principal.principalId,
  ]);
}
