import { createRemoteJWKSet } from "#compiled/jose/index.js";
import { z } from "#compiled/zod/index.js";

const oidcDiscoveryDocumentSchema = z
  .object({
    issuer: z.string().optional(),
    jwks_uri: z.string().url(),
  })
  .passthrough();

const oidcDiscoveryDocumentCache = new Map<
  string,
  Promise<z.output<typeof oidcDiscoveryDocumentSchema>>
>();
const oidcJwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Resolves an issuer's remote JWKS through its OIDC discovery document.
 * Discovery documents and JWKS handles are cached per process, so repeated
 * verifications against the same issuer reuse one key set. Throws when the
 * discovery route is unreachable or returns an invalid document.
 */
export async function getRemoteJwksFromDiscovery(
  discoveryUrl: string,
): Promise<ReturnType<typeof createRemoteJWKSet>> {
  const discoveryDocument = await getOidcDiscoveryDocument(discoveryUrl);
  const existing = oidcJwksCache.get(discoveryDocument.jwks_uri);

  if (existing !== undefined) {
    return existing;
  }

  const remoteJwks = createRemoteJWKSet(new URL(discoveryDocument.jwks_uri));
  oidcJwksCache.set(discoveryDocument.jwks_uri, remoteJwks);

  return remoteJwks;
}

async function getOidcDiscoveryDocument(
  discoveryUrl: string,
): Promise<z.output<typeof oidcDiscoveryDocumentSchema>> {
  const cached = oidcDiscoveryDocumentCache.get(discoveryUrl);

  if (cached !== undefined) {
    return await cached;
  }

  const discoveryPromise = fetch(discoveryUrl, {
    headers: {
      accept: "application/json",
    },
  })
    .then(async (response) => {
      if (!response.ok) {
        throw new Error(`Discovery route returned HTTP ${response.status}.`);
      }

      return oidcDiscoveryDocumentSchema.parse(await response.json());
    })
    .catch((error) => {
      oidcDiscoveryDocumentCache.delete(discoveryUrl);
      throw error;
    });

  oidcDiscoveryDocumentCache.set(discoveryUrl, discoveryPromise);

  return await discoveryPromise;
}
