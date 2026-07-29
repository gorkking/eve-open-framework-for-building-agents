import type { RunInput } from "#channel/types.js";

export const INVOCATION_TOKEN_ATTRIBUTE = "$eve.invocation_token";
export const INVOCATION_OWNER_ATTRIBUTE = "$eve.invocation_owner";

export type ExternalInvocationMetadata = NonNullable<RunInput["externalInvocation"]>;

export function buildInvocationAttributes(
  metadata: ExternalInvocationMetadata,
): Readonly<Record<string, string>> {
  return {
    [INVOCATION_OWNER_ATTRIBUTE]: metadata.ownerKey,
    [INVOCATION_TOKEN_ATTRIBUTE]: metadata.continuationToken,
  };
}
