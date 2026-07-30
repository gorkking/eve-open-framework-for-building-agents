# MCP HTTP interoperability

The channel serves the MCP `2026-07-28` protocol and the official SDK v2's stateless fallback for `2025-11-25` clients. Current clients use `server/discover` and carry protocol and client metadata on each request. Older clients can still use `initialize` and Streamable HTTP. Neither path issues `Mcp-Session-Id`, and DELETE receives `405` because there is no process-local transport session to terminate.

The implementation vendors the official `@modelcontextprotocol/server` v2 package as a build-time dependency and uses its dual-era web-standard handler with `McpServer`. SDK tool registration validates every call against the same JSON Schema returned by `tools/list`. The vendored surface supports modern discovery, legacy initialization, `ping`, `tools/list`, `tools/call`, JSON-RPC errors, protocol validation, and request cancellation without adding an eve runtime dependency. Cancellation of durable agent work is also an explicit tool in the public channel; a cancellation notification arriving on another stateless HTTP request cannot reliably abort an earlier request.

The compatibility tools advertise the complete input-request, input-response,
and connection-authorization shapes. MCP hosts can therefore render HITL
prompts and outbound OAuth challenges directly from tool discovery. Successful
input delivery returns an immediate `working` acknowledgement; clients should
not resubmit the same answers and should resume polling.

The channel mounts Host and exact same-origin request validation in front of
the SDK handler and auth walk. Remote endpoints require HTTPS; loopback HTTP
remains available for local clients. No process-local cache owns invocation
state: active reads consume only a bounded tail snapshot of the durable event
stream, while terminal reads use workflow status and return values directly.

## Inspector

Run the public channel locally or deploy it, then use:

```sh
npx @modelcontextprotocol/inspector
```

In Inspector, select Streamable HTTP, enter `https://<host>/mcp`, authenticate,
connect, list tools, and call each tool. A current client discovers `2026-07-28`;
a 2025 client falls back to stateless initialization. Disconnect and reconnect
before reading an invocation to verify that no transport session owns invocation
state.

For a non-interactive `tools/list` check against a remote endpoint, use the
Inspector's CLI mode:

```sh
npx @modelcontextprotocol/inspector --cli https://<host>/mcp \
  --transport http \
  --method tools/list
```

Add `--header "Authorization: Bearer <token>"` or another configured
authorization header when the endpoint does not use interactive OAuth.

## Claude Code

Current Claude Code setup is expected to be:

```sh
claude mcp add --transport http eve-demo https://<host>/mcp
claude mcp login eve-demo
claude mcp get eve-demo
```

The endpoint's unauthenticated response is `401` with a `WWW-Authenticate: Bearer resource_metadata="..."` challenge. Claude should fetch that RFC 9728 document, discover the external authorization server, authenticate there, and retry `/mcp` with its bearer token.

Provider requirements vary. The authorization server must support Claude's OAuth client flow, including dynamic client registration, or the Claude configuration must supply an explicit client ID. eve remains only the protected resource and does not issue tokens.

The first release intentionally does not vary tool discovery by MCP capabilities. The public milestone exposes compatibility tools to ordinary MCP clients; a later adapter can map MCP Tasks or other capability-specific surfaces onto the same invocation service.

## Vendored footprint

The official server is included through eve's existing compiled-vendor pipeline. The source package remains a dev dependency; consumers still install only eve's runtime dependencies.
