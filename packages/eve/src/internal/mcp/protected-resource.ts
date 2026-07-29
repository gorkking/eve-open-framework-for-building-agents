export interface McpProtectedResourceMetadataOptions {
  readonly authorizationServers: readonly string[];
  readonly resource: string;
  readonly scopesSupported?: readonly string[];
}

/** Creates RFC 9728 protected-resource metadata for an MCP endpoint. */
export function createMcpProtectedResourceMetadata(
  options: McpProtectedResourceMetadataOptions,
): Readonly<Record<string, unknown>> {
  const metadata: Record<string, unknown> = {
    authorization_servers: options.authorizationServers,
    resource: options.resource,
  };
  if (options.scopesSupported !== undefined) {
    metadata.scopes_supported = options.scopesSupported;
  }
  return metadata;
}

/** Creates the RFC 9728 bearer discovery challenge for an MCP resource. */
export function createMcpResourceChallenge(
  resourceMetadataUrl: string,
  scopes?: readonly string[],
): string {
  const parameters = [`resource_metadata="${escapeChallenge(resourceMetadataUrl)}"`];
  if (scopes?.length) parameters.push(`scope="${escapeChallenge(scopes.join(" "))}"`);
  return `Bearer ${parameters.join(", ")}`;
}

function escapeChallenge(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
