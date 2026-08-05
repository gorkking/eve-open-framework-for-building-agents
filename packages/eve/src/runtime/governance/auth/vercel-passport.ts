import { decodeJwt, jwtVerify } from "#compiled/jose/index.js";

import { getRemoteJwksFromDiscovery } from "#runtime/governance/auth/oidc-discovery.js";
import { createJwtAuthenticatedCallerPrincipal } from "#runtime/governance/auth/token-claims.js";
import type {
  CurrentVercelProject,
  RouteStrategyAuthenticationResult,
} from "#runtime/governance/auth/types.js";

/**
 * Team-scoped issuer prefix for Vercel Passport identity tokens
 * (`https://passport.vercel.com/[TEAM_SLUG]`).
 */
const VERCEL_PASSPORT_ISSUER_PREFIX = "https://passport.vercel.com/";

/**
 * Resolved Vercel Passport auth strategy.
 */
export interface ResolvedVercelPassportAuthStrategy {
  readonly clockSkewSeconds: number;
  readonly currentVercelProject: CurrentVercelProject | undefined;
}

/**
 * Verifies one Vercel Passport identity token against a resolved strategy.
 *
 * Mirrors the checks Vercel documents for verifying Passport tokens: the
 * RS256 signature against the issuer's JWKS (resolved through OIDC
 * discovery), the team-scoped `https://passport.vercel.com/` issuer, the
 * `typ: "passport"` claim, the required identity claims (`sub`, `owner`,
 * `connector_id`, `external_sub`), the validity window, and a fail-closed
 * `project_id` / `environment` bind against the configured current project.
 */
export async function authenticateVercelPassportStrategy(input: {
  readonly token: string;
  readonly strategy: ResolvedVercelPassportAuthStrategy;
}): Promise<RouteStrategyAuthenticationResult> {
  const issuer = decodeUnverifiedIssuer(input.token);
  if (issuer === null) {
    return { kind: "not-authenticated" };
  }

  if (!issuer.startsWith(VERCEL_PASSPORT_ISSUER_PREFIX)) {
    return { kind: "not-authenticated" };
  }

  let remoteJwks: Awaited<ReturnType<typeof getRemoteJwksFromDiscovery>>;
  try {
    remoteJwks = await getRemoteJwksFromDiscovery(
      `${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
    );
  } catch (error) {
    return {
      kind: "misconfigured",
      message: `Failed to load Vercel Passport discovery metadata. ${error instanceof Error ? error.message : "Unknown discovery failure."}`,
    };
  }

  try {
    const verified = await jwtVerify(input.token, remoteJwks, {
      algorithms: ["RS256"],
      clockTolerance: input.strategy.clockSkewSeconds,
      issuer,
    });

    if (verified.payload.typ !== "passport") {
      return { kind: "not-authenticated" };
    }

    const hasRequiredIdentityClaims =
      isNonEmptyString(verified.payload.sub) &&
      isNonEmptyString(verified.payload.owner) &&
      isNonEmptyString(verified.payload.connector_id) &&
      isNonEmptyString(verified.payload.external_sub);
    if (!hasRequiredIdentityClaims) {
      return { kind: "not-authenticated" };
    }

    if (!currentVercelProjectMatches(verified.payload, input.strategy)) {
      return { kind: "caller-not-allowed" };
    }

    return {
      kind: "authenticated",
      principal: createJwtAuthenticatedCallerPrincipal({
        authenticator: "oidc",
        payload: verified.payload,
        principalType: "user",
      }),
    };
  } catch {
    return { kind: "not-authenticated" };
  }
}

/**
 * Returns whether the token's `project_id` and `environment` claims match
 * the configured current project. Fails closed when the current project or
 * environment is absent, so a Passport token can never authenticate without
 * an explicit deployment bind.
 */
function currentVercelProjectMatches(
  payload: Record<string, unknown>,
  strategy: ResolvedVercelPassportAuthStrategy,
): boolean {
  const currentProject = strategy.currentVercelProject;
  if (currentProject === undefined) {
    return false;
  }
  const currentEnvironment = currentProject.environment;
  if (currentEnvironment === undefined || currentEnvironment.length === 0) {
    return false;
  }

  return (
    payload.project_id === currentProject.projectId && payload.environment === currentEnvironment
  );
}

function decodeUnverifiedIssuer(token: string): string | null {
  try {
    const payload = decodeJwt(token);
    return typeof payload.iss === "string" && payload.iss.length > 0 ? payload.iss : null;
  } catch {
    return null;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
