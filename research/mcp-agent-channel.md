---
issue: TBD
status: proposed
last_updated: "2026-07-29"
---

# MCP channel plan

## Summary

eve should support an opt-in `mcpChannel()` that lets MCP hosts such as Claude and Codex delegate
durable work to an eve agent.

The first version should:

1. publish the agent as one durable agent-invocation capability, not automatically republish all of
   its authored tools, skills, instructions, connections, or subagents;
2. use a protocol-neutral invocation service shared by the MCP adapters and any future remote-agent
   transport;
3. treat the MCP `2026-07-28` stateless protocol and Tasks extension as the target architecture,
   while retaining ordinary compatibility tools for clients that do not yet support Tasks;
4. reuse eve's existing `SessionAuthContext` principal model, adapting MCP access-token verification
   into it alongside protected-resource discovery, challenges, and scopes;
5. implement the MCP resource-server auth glue in eve core rather than wrapping
   `vercel/mcp-handler`;
6. act only as an OAuth resource server—token issuance, client registration, DCR, CIMD, and provider
   policy belong to an external authorization server or integration;
7. bind invocations to the initiating principal by default and offer an explicit authorization hook
   for team sharing or capability-handle semantics;
8. document Deployment Protection as a separate edge constraint instead of claiming that generic
   MCP OAuth works through a protected deployment today.

The MCP channel is complementary to `eve invoke`: it is the standard way for an arbitrary MCP host to discover and
delegate to an eve agent.

## Recommended v1 shape

The minimal preconfigured-auth experience matches the strongest part of PR #884:

```ts title="agent/channels/mcp.ts"
import { localDev, vercelOidc } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  auth: [vercelOidc(), localDev()],
});
```

Interactive OAuth is the same channel with a generic resource-policy decorator:

```ts title="agent/channels/mcp.ts"
import { oauthResource } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";
import { verifyAccessToken } from "../lib/auth";

export default mcpChannel({
  auth: oauthResource(verifyAccessToken, {
    issuer: process.env.AUTH_ISSUER!,
    scopes: ["agent:invoke"],
  }),
});
```

The first public input can stay small:

```ts
interface McpChannelInput {
  auth: AuthFn<Request> | readonly AuthFn<Request>[] | OAuthResourceAuth;
  path?: string; // defaults to "/mcp"
}
```

Do not add these to v1:

- a public `surface` or `mode` discriminator while only agent invocation exists;
- static capability/resource export;
- `onRequest`;
- a harness-controlled session ID;
- tool exposure filters;
- provider-specific OAuth configuration.

For agent invocation, route auth already determines the effective `SessionAuthContext`, and eve
must generate the durable session/invocation identity. A future `onRequest` can add correlation
metadata or advanced principal projection when a concrete use case requires it. It must never let
an external harness replace eve's real session ID.

## End experience

### What the user experiences

The user stays in their MCP host and asks it to delegate:

> Ask the release agent to investigate the failed deployment and propose a fix.

The host discovers one agent tool from the eve MCP server. It starts the work once, receives a
durable task or invocation handle, and can reconnect, answer an input request, cancel the work, or
retrieve the final result without starting the eve run again.

This is "chat with an eve agent through an MCP client" in the host-native sense: the user chats with
Claude, Codex, or another host, and that host invokes the eve agent. The first release does not try
to replace the eve web chat with a second direct-chat protocol.

### What the agent author writes

The channel is an explicit root-agent channel:

```ts title="agent/channels/mcp.ts"
import { oauthResource } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";
import { verifyAccessToken } from "../lib/auth";

export default mcpChannel({
  auth: oauthResource(verifyAccessToken, {
    issuer: process.env.AUTH_ISSUER!,
    scopes: ["agent:invoke"],
  }),
});
```

The exact helper names are provisional. The intended shape is not:

- an OAuth server embedded in eve;
- a provider-specific token introspector embedded in `mcpChannel`;
- a wrapper around the compiled channel after authoring; or
- a second principal type unrelated to other eve channels.

`oauthResource` lives in `eve/channels/auth` because any inbound HTTP channel can be an OAuth
protected resource. It takes an existing `AuthFn<Request>` (or ordered array) as its first argument
and OAuth resource configuration as its second. It decorates the existing strategy with portable
resource metadata; it does not introduce another principal or verifier contract.

`issuer` is shorthand for the common case of one authorization server and is emitted as the MCP PRM
`authorization_servers` value. An advanced `authorizationServers` array can support multiple
issuers when needed. This keeps all authentication protocol configuration under `auth` without the
awkward `auth.authenticate` nesting or exposing protocol wire names in the common authoring path.
The underlying function still produces the same `SessionAuthContext` visible at
`ctx.session.auth`.

This is the only authored configuration required. `mcpChannel()` consumes the OAuth strategy and
automatically mounts:

- the MCP resource endpoint, `/mcp` by default;
- its Protected Resource Metadata endpoint, `/.well-known/oauth-protected-resource` by default;
- the corresponding `WWW-Authenticate` challenge pointing at that metadata endpoint;
- metadata CORS/`OPTIONS` behavior required by supported clients.

The channel derives the canonical resource URL from the public request origin plus its MCP path.
Advanced deployments can override the resource URL or metadata path when a gateway fronts the eve
origin. Authors should not need to create a second channel file or manually export a well-known
route. The compiler must reject route collisions if another channel already owns the selected
well-known path.

`verifyAccessToken` is an authored or provider-supplied `AuthFn<Request>`. Like every existing eve
auth strategy, it reads the request, verifies the credential, and returns `SessionAuthContext`. The
example deliberately does not use eve's `oidc()` helper: OpenID Connect can be one way to discover
keys and claims for JWT access tokens, but MCP authorization is OAuth and does not require OIDC. An
authorization server may issue opaque access tokens that require introspection instead. An OIDC ID
token must not be accepted as the MCP access token.

Existing eve strategies compose directly when they match the authorization server's access-token
format:

```ts
import { jwtEcdsa, localDev, oauthResource } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  auth: oauthResource(
    [
      localDev(),
      jwtEcdsa({
        algorithm: "ES256",
        issuer: process.env.AUTH_ISSUER!,
        audiences: [process.env.MCP_RESOURCE!],
        publicKey: process.env.AUTH_PUBLIC_KEY!,
      }),
    ],
    {
      issuer: process.env.AUTH_ISSUER!,
      scopes: ["agent:invoke"],
    },
  ),
});
```

The same composition works with `jwtHmac()`, a correctly configured `oidc()` for JWT access tokens,
or a provider-authored `AuthFn` that performs RFC 7662 introspection. `httpBasic()` and other
non-bearer strategies can secure controlled deployments, but they do not produce the interoperable
MCP OAuth login flow.

Provider integrations can return the whole `OAuthResourceAuth` strategy:

```ts title="agent/channels/mcp.ts"
import { mcpChannel } from "eve/channels/mcp";
import { betterAuthMcp } from "@acme/eve-mcp-better-auth";

export default mcpChannel({
  auth: betterAuthMcp(auth),
});
```

Here, `betterAuthMcp(auth)` returns the same structural strategy as `oauthResource(...)`.

Better Auth is not required by the channel. Its role is to provide an authorization server for an
app that does not already have one: login, consent, authorization/token endpoints, client
registration, access/refresh token issuance, and provider metadata. A Better Auth adapter would
point eve's PRM at that server, verify its access tokens, and map its user/client identity into
`SessionAuthContext`.

If Vercel, Auth0, Okta, or another existing provider supplies those capabilities, use that provider
instead. Better Auth does not replace `mcpChannel()` or eve's resource-server enforcement.

The current Better Auth OIDC Provider plugin documents DCR, authorization-code/public-client flows,
consent, and access/refresh tokens, but is marked as active development and planned for replacement
by its OAuth Provider plugin. Treat it as a provider-integration candidate rather than the default
eve dependency until the replacement's MCP interoperability is proven.

Omitting `auth` fails closed. Deliberately public exposure uses the existing explicit `none()` auth
helper rather than an omitted option or silent fallback:

```ts title="agent/channels/mcp.ts"
import { none } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  auth: none(),
});
```

The server name and tool description come from the compiled root agent's name and description.
Structured output remains an agent or invocation concern, not channel identity.

### What connecting looks like

The ideal production flow is one URL plus the MCP host's normal login:

```sh
claude mcp add --transport http release-agent https://release-agent.example.com/mcp
claude mcp login release-agent
```

Equivalent UI-based MCP setup should work in hosts that do not expose a CLI. The exact commands are
acceptance-test examples, not an eve-managed client interface.

The OAuth flow is:

1. the host calls the public MCP resource;
2. eve returns an MCP-compatible `401` pointing to Protected Resource Metadata (PRM);
3. PRM identifies the external authorization server and canonical MCP resource;
4. the host uses pre-registration, Client ID Metadata Documents (CIMD), or Dynamic Client
   Registration (DCR), depending on what the host and authorization server support;
5. the authorization server issues a resource-bound access token;
6. eve verifies the token through the authored auth strategy, derives `SessionAuthContext`, and
   authorizes the operation;
7. the same principal is recorded as the durable eve session initiator.

The authorization server may live on another domain. eve does not need to serve `/authorize`,
`/token`, or `/register`.

### How bearer tokens work

OAuth access tokens reach the MCP resource as bearer credentials:

```http
Authorization: Bearer <access-token>
```

Bearer is the HTTP credential format; OAuth is how the client discovers the authorization server
and obtains that credential. For `auth: oauthResource(verifyAccessToken, options)`, eve:

1. invokes the existing eve `AuthFn` with the full request;
2. the strategy verifies the bearer access token and returns `SessionAuthContext` or rejects;
3. the MCP wrapper returns an MCP `401` with the PRM URL when authentication is missing or invalid;
4. it enforces the configured scopes and operation policy;
5. it runs the MCP request as that principal.

Bearer extraction remains centralized in eve's existing auth helpers or a provider-supplied
`AuthFn`; the MCP wrapper does not parse the same credential a second time. MCP-specific challenge
formatting remains in the consuming channel.

Every MCP request—including `tasks/get`, `tasks/update`, and `tasks/cancel`—must carry and reverify
the token. The token is never placed in the query string, persisted with the invocation, forwarded
to tools, or used as the invocation ID.

An existing eve bearer-token strategy can support controlled clients that already possess a token:

```ts
import { jwtHmac } from "eve/channels/auth";
import { mcpChannel } from "eve/channels/mcp";

export default mcpChannel({
  auth: jwtHmac({
    algorithm: "HS256",
    issuer: "internal",
    audiences: ["release-agent"],
    secret: process.env.MCP_SHARED_SECRET!,
  }),
});
```

This returns a normal `WWW-Authenticate: Bearer` challenge but has no authorization-server
discovery or login flow. The MCP host must be configured to send the token itself. It is useful for
service-to-service calls and smoke tests, not the preferred end-user experience.

## Product boundaries

### What the channel publishes

The default surface publishes the agent as an agent:

- its model-visible identity comes from the compiled root agent;
- a call starts one task-mode eve session;
- the result is the agent's final output;
- pending eve input requests become MCP task input requests or compatibility-tool state;
- cancellation is cooperative and eventually reflected in task state.

It does not automatically publish:

- authored tools;
- MCP connections used by the agent;
- instructions or skills as prompts/resources;
- subagents as separate tools;
- the eve filesystem;
- session/event inspection beyond the invocation the caller is authorized to access.

Directly exposing authored capabilities can be designed later. It has a different security and
product model from asking the agent to use those capabilities on the caller's behalf.

### MCP versus `eve invoke`

| Need                                                          | Recommended surface                                             |
| ------------------------------------------------------------- | --------------------------------------------------------------- |
| Local scripting or a skill running beside the repo            | `eve invoke`                                                    |
| Vercel CLI-authenticated access to a protected eve deployment | `eve invoke`                                                    |
| A standard MCP host delegating to an agent                    | `mcpChannel()`                                                  |
| eve-to-eve delegation with lineage and inherited limits       | Existing remote agent initially; future MCP-backed remote agent |
| Direct browser chat                                           | eve HTTP channel and frontend client                            |

MCP should not be held back because `eve invoke` exists, but the MCP channel also should not recreate
CLI authentication or make the CLI depend on MCP.

## Protocol surface

### Preferred path: MCP Tasks

For clients declaring `io.modelcontextprotocol/tasks` in their per-request capabilities, expose one
obvious tool, provisionally named `agent`:

```ts
agent({
  message: string,
  outputSchema?: JsonObject,
})
```

The server may return a `CreateTaskResult` backed by the durable eve invocation. The mapping is:

| eve invocation operation  | MCP Tasks                         |
| ------------------------- | --------------------------------- |
| Create task-mode session  | task-returning `tools/call agent` |
| Read current state/result | `tasks/get`                       |
| Answer pending input      | `tasks/update`                    |
| Request cancellation      | `tasks/cancel`                    |
| Invocation ID             | Task ID                           |

The task is durably readable before its ID is returned. A completed `tasks/get` carries the final
tool result. A client must honor `pollIntervalMs`.

### Compatibility path

Hosts without Tasks support receive ordinary tools:

- `agent_start({ message, outputSchema? })`
- `agent_get({ invocationId })`
- `agent_update({ invocationId, responses })`
- `agent_cancel({ invocationId })`

`agent_start` returns after durable acceptance, not after the agent finishes. The host must retain
the returned ID and must not automatically retry an ambiguously failed start. `agent_get` returns
complete current state plus a polling hint and never runs a model.

Conversation continuation (`agent_send`) should be deferred until the task-delegation path is
proven. It can be added without changing the task-mode service, but it introduces a second product
mode and more opportunity for hosts to confuse their own chat history with the eve session.

### Version compatibility

The target wire model is MCP `2026-07-28`:

- requests are stateless at the protocol layer;
- capability and client metadata travel per request;
- durable application state is represented by explicit task/invocation handles;
- the Tasks extension uses `tasks/get`, `tasks/update`, and `tasks/cancel`.

The implementation spike must still test the protocol versions used by current Claude, Codex, MCP
Inspector, and the TypeScript SDK. If those clients have not all adopted `2026-07-28`, the server
may need a contained `2025-11-25` compatibility adapter. Protocol-version compatibility must not
create a second invocation state machine.

Prefer the official MCP TypeScript SDK once its stateless server and Tasks support satisfy eve's
runtime/bundling constraints. A custom or vendored protocol adapter should be a deliberate fallback,
covered by conformance scenarios, rather than the default.

## Invocation service

MCP transport handlers should call one internal, protocol-neutral service:

```ts
interface AgentInvocationService {
  create(input: CreateInvocationInput): Promise<AgentInvocation>;
  read(input: InvocationOperationInput): Promise<AgentInvocation>;
  update(input: UpdateInvocationInput): Promise<AgentInvocation>;
  cancel(input: InvocationOperationInput): Promise<AgentInvocation>;
}
```

The service starts a normal `mode: "task"` session through the channel/runtime boundary. It does not
own a second model loop.

The public state is:

```ts
interface AgentInvocation {
  invocationId: string;
  status: "working" | "input_required" | "completed" | "failed" | "cancelled";
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  pollAfterMs?: number;
  inputRequests?: Record<string, McpInputRequest>;
  result?: unknown;
  error?: {
    code: string;
    message: string;
  };
}
```

The source of truth must survive process and deployment restarts. An initial implementation may
project current state from the durable eve session event stream. If that makes reads grow with the
full event history, add a compact invocation projection behind the same service interface.

The durable record must never contain the caller's bearer token, OAuth authorization code, refresh
token, live request object, or MCP transport object.

### State mapping

- eve running -> `working`
- eve waiting on a supported input request -> `input_required`
- successful terminal output -> `completed`
- workflow/runtime failure -> `failed`
- acknowledged cooperative cancellation -> `cancelled`
- missing or expired record -> stable not-found/expired error

An application-level error returned as the agent's authored output remains a completed tool result.
Protocol/runtime failure is a failed invocation.

## Authentication and authorization

### Auth strategy contract

`mcpChannel()` accepts either:

- an existing `AuthFn<Request>` (or ordered array) for non-OAuth/manual auth; or
- the `OAuthResourceAuth` returned by `oauthResource(authFn, options)`.

An OAuth strategy contains:

- an existing `AuthFn<Request>` or ordered array that produces the same `SessionAuthContext`
  principal as `eveChannel`;
- Protected Resource Metadata values:
  - `authorization_servers`;
  - canonical `resource`;
  - supported/required scopes;

`authorizeInvocation` remains a separate channel option because it governs durable invocation
ownership after request authentication, not the OAuth handshake itself.

The channel should reuse `routeAuth`'s principal semantics, but its failures need MCP-specific
`WWW-Authenticate` metadata. The auth function remains responsible for actual token verification,
including issuer, signature, expiry, audience/resource, and provider claims. MCP must not accept a
token merely because it is a structurally valid JWT.

The resource defaults to the request origin plus channel path, such as
`https://agent.example.com/mcp`. Authors must be able to override it when a public gateway fronts a
private eve origin.

### Minimal `oauthResource()` implementation

The first implementation can be small. `oauthResource()` does not authenticate by itself; it
composes an existing auth function and attaches resource-server metadata:

```ts
interface OAuthResourceOptions {
  issuer: string;
  scopes?: readonly string[];
  resource?: string;
  metadataPath?: string;
}

interface OAuthResourceAuth extends AuthFn<Request> {
  readonly [oauthResourceMetadata]: OAuthResourceOptions;
}

function oauthResource(
  auth: AuthFn<Request> | readonly AuthFn<Request>[],
  options: OAuthResourceOptions,
): OAuthResourceAuth;
```

The implementation returns one `AuthFn` that preserves the existing ordered strategy walk and has
non-enumerable symbol metadata. That makes it backward-compatible anywhere an `AuthFn` is already
accepted while allowing a channel factory to detect the resource policy without inspecting a
provider-specific function.

`mcpChannel()` then performs three additional jobs:

1. add `GET` (and CORS/`OPTIONS` support) for the configured PRM well-known path;
2. derive the default resource as the public request origin plus `/mcp`;
3. when `routeAuth()` returns `401` or `403`, add the MCP `WWW-Authenticate` challenge pointing to
   PRM.

The PRM response for the common case is:

```json
{
  "resource": "https://agent.example.com/mcp",
  "authorization_servers": ["https://auth.example.com"],
  "scopes_supported": ["agent:invoke"]
}
```

The underlying `AuthFn` remains responsible for signature/introspection, expiry, audience/resource,
and scope enforcement. `scopes` in `OAuthResourceOptions` advertises the scopes in PRM and in an
insufficient-scope challenge; it does not make an unverified claim trustworthy.

No OAuth endpoints, database, DCR implementation, token storage, SDK `AuthInfo`, or dependency on
`mcp-handler` is required for this slice.

### Why this belongs in eve core

eve should implement this resource-server layer directly and should not depend on
[`vercel/mcp-handler`](https://github.com/vercel/mcp-handler).

`mcp-handler` is a general framework route adapter. Its `withMcpAuth` wrapper extracts a bearer
token, invokes an MCP SDK `AuthInfo` verifier, checks expiry/scopes, attaches auth to the request,
and emits MCP challenges around an arbitrary handler. That is useful for a standalone Next.js,
Nuxt, or similar MCP route.

eve already owns the corresponding layers:

- compiled channel routes and dispatch;
- the `AuthFn` and `SessionAuthContext` identity model;
- durable session creation and delivery;
- invocation ownership and operation authorization;
- MCP tool/task mapping;
- the runtime and bundling boundary.

Depending on `mcp-handler` would add a second route/auth context around eve's channel and require an
adapter from `AuthInfo` back into `SessionAuthContext`. It would also couple the channel's protocol
version and transport lifecycle to a general-purpose handler package.

eve core should therefore own:

- bearer extraction;
- `routeAuth` integration;
- MCP-compliant `401`/`403` responses and `WWW-Authenticate`;
- PRM route generation;
- scope challenge metadata;
- safe projection of the authenticated principal into the invocation;
- tests for malformed, missing, expired, wrong-audience, and insufficient-scope tokens.

This does not mean reimplementing OAuth or token cryptography. Auth providers and eve's existing
auth helpers still verify the token. The official MCP SDK should remain the preferred source for
protocol types, parsing, errors, and conformance where it fits eve's runtime. `mcp-handler` can be a
behavioral reference, but not a runtime dependency or public abstraction.

### Invocation ownership

Every create, read, update, and cancel operation authenticates independently.

The default policy is:

- creation is allowed to a principal accepted by the channel auth strategy;
- the invocation stores a token-free identity projection for its initiator;
- later operations require the same stable principal identity;
- the opaque task/invocation ID is necessary but not sufficient authorization.

An author may explicitly configure a broader policy, for example team-wide access or possession of
the unguessable invocation ID:

```ts
mcpChannel({
  auth: oauthResource(verifyAccessToken, {
    issuer: process.env.AUTH_ISSUER!,
    scopes: ["agent:invoke"],
  }),
  authorizeInvocation({ caller, invocation, operation }) {
    return caller.attributes.teamId === invocation.initiator.attributes.teamId;
  },
});
```

The exact API can change, but cross-principal access must not be the accidental default.

This policy is route/invocation authorization, not the agent's complete capability ceiling. The eve
agent's tool, connection, sandbox, approval, and cost policies still apply independently. A future
delegation policy may narrow those capabilities per token or invocation; it must never broaden the
receiver's configured ceiling.

### OAuth provider responsibilities

The external authorization server is responsible for:

- authorization and token endpoints;
- user consent/login;
- OAuth/OIDC metadata;
- resource indicators and audience-bound token issuance;
- one or more client registration approaches supported by MCP clients:
  - pre-registration;
  - CIMD;
  - DCR;
- exact redirect URI validation, PKCE, refresh-token policy, and provider security.

eve is responsible for:

- the MCP resource endpoint;
- PRM and `WWW-Authenticate` challenges;
- access-token verification through the configured strategy;
- scope/operation enforcement;
- projection into `SessionAuthContext`;
- never passing the MCP access token through to downstream tools or services.

## Vercel Deployment Protection

Deployment Protection and MCP OAuth are separate authentication layers. A protected deployment can
intercept the initial unauthenticated MCP request before eve returns the required MCP `401` and PRM
challenge. A generic MCP client also cannot be assumed to propagate a Vercel protection-bypass
query parameter or header across PRM, authorization, token, and MCP requests.

The supported-experience matrix should be explicit:

| Deployment                                 | MCP channel auth                                          | Expected support                                      |
| ------------------------------------------ | --------------------------------------------------------- | ----------------------------------------------------- |
| Publicly reachable production domain       | OAuth bearer                                              | Supported target                                      |
| Publicly reachable production domain       | Static/custom bearer header                               | Supported                                             |
| Publicly reachable production domain       | Explicit public mode                                      | Supported but intentionally dangerous                 |
| Deployment Protection enabled              | Standard MCP OAuth                                        | Not supported without platform/edge changes           |
| Deployment Protection enabled              | Protection bypass manually configured in a capable client | Possible for controlled testing, not the generic UX   |
| Public MCP gateway -> protected eve origin | OAuth at gateway + signed/trusted forwarding              | Supported architecture after an integration is proven |

For a gateway deployment:

1. the public gateway serves MCP PRM and performs or delegates OAuth;
2. it authorizes the operation;
3. it forwards a short-lived, audience-bound, signed identity assertion to the private eve origin;
4. the private origin cryptographically verifies that assertion and maps it to
   `SessionAuthContext`;
5. the gateway reaches the origin through a supported Vercel trust mechanism, such as Trusted
   Sources or a narrowly scoped automation bypass.

Unsigned identity headers are never trusted.

The desired `claude mcp add v.vercel.tools` experience therefore requires either:

- a publicly reachable MCP resource with its own OAuth policy;
- a Vercel-native gateway/resource-server product; or
- Deployment Protection support for path-level MCP discovery and bearer challenges.

That limitation should not prevent the channel from shipping for unprotected production domains,
other platforms, custom gateways, or non-OAuth bearer strategies.

## Implementation plan

### 0. Interoperability spike

Before freezing the public API:

1. record the protocol versions and Tasks support in current Claude, Codex, MCP Inspector, and the
   official TypeScript SDK;
2. prove a stateless `server/discover`, `tools/list`, and `tools/call` route on eve's Nitro runtime;
3. prove per-request capability detection;
4. verify HTTP status, `Mcp-Method`/`Mcp-Name`, CORS, body limits, cancellation, and cache behavior;
5. run a real OAuth login against one provider supporting a realistic MCP client-registration
   route;
6. record exactly what fails with Deployment Protection enabled.

This spike has no public API.

### 1. Protocol-neutral durable invocation service

Add the internal invocation service independently of MCP:

1. create task-mode sessions;
2. durably map invocation IDs to session state;
3. read current/terminal state without starting work;
4. project pending input requests and accept responses;
5. request and observe cancellation;
6. enforce expiry and principal-bound access;
7. prove restart-safe reads and idempotent updates/cancellation.

Use the existing channel/runtime primitives (`send`, session event streams, and durable delivery)
rather than reaching around them from the MCP adapter.

### 2. Stateless MCP adapter and compatibility tools

Add:

- `eve/channels/mcp`;
- `mcpChannel()`;
- reuse of the public channel `SessionAuthContext` principal contract;
- generic `OAuthResourceAuth` and `oauthResource()` types/helpers in `eve/channels/auth`;
- `/mcp` Streamable HTTP route(s);
- PRM route and MCP challenges;
- agent metadata projection;
- compatibility tools over `AgentInvocationService`;
- docs and a deterministic fixture.

Auth omission fails closed. Public mode is explicit. No authored capability is exposed implicitly.

### 3. MCP Tasks adapter

Map the Tasks extension onto the same invocation service:

- task-returning `agent` tool;
- `tasks/get`;
- `tasks/update`;
- `tasks/cancel`;
- capability-aware response selection;
- task input-request and terminal-result mapping.

Compatibility tools remain available only where needed for client interoperability. They do not
become a parallel execution model.

### 4. Provider and gateway integrations

Prove at least one external OAuth provider and one Vercel gateway pattern. These can live in
provider packages or examples rather than in eve core.

Document:

- the required PRM and authorization-server metadata;
- resource/audience configuration;
- CIMD, pre-registration, or DCR expectations;
- token-to-`SessionAuthContext` mapping;
- Deployment Protection behavior;
- secure signed forwarding to a private origin.

### 5. Follow-ups

After the external-host experience is stable:

1. compact invocation state projection if event replay is too expensive;
2. conversation-mode continuation;
3. MCP-backed remote agents/subagents using the same Tasks client;
4. delegated capability/cost ceilings and lineage;
5. migration of `defineRemoteAgent` only after MCP parity is proven;
6. optional direct publication of selected authored tools under a separate API and security review.

## Verification

### Unit

- protocol validation and errors;
- state/result/error mapping;
- auth challenge formatting;
- PRM derivation and explicit resource override;
- scope and operation authorization;
- same-principal default ownership;
- task/compatibility mapping;
- ambiguous-create and retry behavior.

### Integration

- unauthenticated `401` -> PRM -> authenticated retry;
- create/read/update/cancel;
- restart-safe reads;
- duplicate update/cancel requests;
- input-required round trip;
- expired token and insufficient scope;
- cross-principal rejection and explicitly allowed team sharing;
- no bearer material persisted in session/invocation state.

### Scenario

- real Nitro HTTP endpoint and MCP client subprocess;
- `2026-07-28` stateless request path;
- any supported legacy protocol adapter;
- disconnect/reconnect during work;
- MCP Tasks and non-Tasks clients;
- horizontal requests reaching different server instances.

### Manual/client matrix

For each of Claude, Codex, and MCP Inspector, record:

- add/connect UX;
- protocol version;
- OAuth registration mechanism;
- login success;
- Tasks support;
- compatibility-tool behavior;
- reconnect behavior;
- cancellation;
- input-required behavior.

Test public production, protected preview, and public-gateway/private-origin deployment shapes
separately.

## Invariants

- A status read never starts work.
- An ambiguously failed create is not retried automatically.
- A task/invocation handle is durably readable before it is returned.
- Every invocation operation authenticates and authorizes independently.
- Invocation IDs are unguessable and are not the sole authorization mechanism by default.
- Bearer and refresh tokens are never persisted in eve session state.
- The MCP endpoint does not implicitly expose the agent's internal capabilities.
- Compatibility tools and MCP Tasks use one invocation service and state machine.
- The receiver's own capabilities and policies are always the upper bound.
- The MCP protocol remains stateless even though the eve work is durable.
- Provider OAuth behavior stays outside the transport core.

## Non-goals for the first release

- making eve an OAuth authorization server;
- solving Deployment Protection inside the eve package;
- exposing every agent tool, prompt, resource, skill, or connection;
- replacing the eve browser chat;
- replacing `eve invoke`;
- replacing `defineRemoteAgent` before parity;
- cross-deployment billing or cost settlement;
- arbitrary MCP sampling;
- public invocation listing;
- treating a task ID as permission to access every invocation.

## Decisions to make during the spike

1. Does the official TypeScript SDK support eve's target stateless and Tasks behavior without an
   unacceptable runtime/bundle cost?
2. Which protocol versions must the first release support for current Claude and Codex clients?
3. Can tool discovery cleanly show `agent` to Tasks clients and compatibility tools to other clients,
   or should both be listed with clear preference descriptions?
4. What is the smallest durable projection needed for constant-cost invocation reads?
5. Should the advanced multi-authorization-server option be exposed in the first release, or added
   only when a concrete provider needs it?
6. What stable principal fields are required for default ownership when an auth provider rotates
   clients or changes token subjects?
7. Which provider gives the best documented CIMD/pre-registration/DCR demo?
8. What Vercel gateway and private-origin trust pattern should be the supported Deployment
   Protection workaround?

## Relationship to PR #884

[PR #884](https://github.com/vercel/eve/pull/884) describes a different MCP product behind a similar
channel API:

| Area             | PR #884                                                                    | This plan                                                                    |
| ---------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Primary consumer | External harness using eve-authored capabilities                           | MCP host delegating work to the eve agent                                    |
| MCP surface      | Static instructions/skills as resources and static authored tools as tools | One agent tool plus Tasks or compatibility lifecycle                         |
| Execution        | Direct `tool.execute()` in an ephemeral context                            | Durable task-mode eve session and model run                                  |
| Session          | Optional harness-projected logical ID; no durable eve session              | Server-generated durable invocation/session ID                               |
| Interactive work | No interactive approval/auth/input                                         | Input-required updates and cooperative cancellation                          |
| Protocol/auth    | MCP `2025-11-25`, preconfigured `AuthFn`, no PRM                           | Target `2026-07-28`, existing `AuthFn` plus optional OAuth resource metadata |

These surfaces should not be silently combined. If the server advertises authored tools alongside
an agent-delegation tool, the external model can bypass the eve agent's reasoning and instructions,
while the security and lifecycle semantics differ per tool.

The #884 authoring shape contains useful shared edge behavior:

```ts
mcpChannel({
  auth: [vercelOidc(), localDev()],
  onRequest(ctx) {
    return {
      auth: defaultMcpAuth(ctx),
      session: { id: readHarnessSessionId(ctx.mcp.request) },
    };
  },
});
```

- Direct `auth: AuthFn | AuthFn[]` should remain supported. It is the minimal preconfigured
  credential/service-auth mode.
- `oauthResource(auth, options)` is additive only when the server needs interoperable MCP OAuth
  discovery. It must not wrap `vercelOidc()` unless the advertised authorization server actually
  issues tokens that `vercelOidc()` accepts.
- `onRequest` and `defaultMcpAuth(ctx)` remain useful ideas for a future capability-export surface
  that needs request-scoped logical tool context, but they are not required for v1 agent invocation.

The `session` projection has different meaning in the two designs. In #884 it is tool-visible
logical context only; every direct call still has a private execution and sandbox identity. In a
durable invocation channel, an external header must not choose or replace the real eve session ID.
The equivalent hook should record a harness correlation ID as metadata while eve generates the
durable session/invocation identity.

The v1 decision is to ship only durable agent invocation. Do not add a public discriminator while
there is only one surface, and do not expose compiled capabilities implicitly. Keep the internal
transport, auth, request-admission, and capability-registration boundaries reusable so #884's
direct capability export can be revisited later under an explicit, separately reviewed API.

## Treatment of PR #1203

PR #1203 is useful implementation research. Its durable invocation service, stateless transport,
fail-closed auth, explicit public mode, protected-resource metadata, and compatibility-tool tests
should inform the new work.

It should not lock in:

- a second identity model instead of existing `AuthFn`/`SessionAuthContext`;
- cross-principal access by possession of an invocation ID;
- a pre-`2026-07-28` transport shape as the long-term architecture;
- compatibility tools as the only lifecycle after MCP Tasks adoption; or
- an implication that standard OAuth works through Deployment Protection.

The next implementation should be cut into reviewable boundaries from current `main`, reusing code
or tests from #1203 selectively after the interoperability spike answers the open questions.

## References

- [MCP `2026-07-28` release overview](https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/)
- [MCP Tasks extension](https://modelcontextprotocol.io/seps/2663-tasks-extension)
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP authorization tutorial](https://modelcontextprotocol.io/docs/tutorials/security/authorization)
- [Deploy MCP servers to Vercel](https://vercel.com/docs/mcp/deploy-mcp-servers-to-vercel)
- [Vercel Deployment Protection](https://vercel.com/docs/deployment-protection)
- [Protection bypass for automation](https://vercel.com/docs/deployment-protection/methods-to-bypass-deployment-protection/protection-bypass-automation)
- [Trusted Sources for Deployment Protection](https://vercel.com/changelog/trusted-sources-for-deployment-protection)
