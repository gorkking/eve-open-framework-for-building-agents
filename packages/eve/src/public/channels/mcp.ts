import { parseJsonObject, type JsonObject } from "#shared/json.js";
import { defineChannel, DELETE, GET, POST, type Channel } from "#public/definitions/channel.js";
import type { RouteHandlerArgs } from "#channel/routes.js";
import {
  AgentInvocationService,
  type AgentInvocation,
} from "#internal/invocation/agent-invocation-service.js";
import { WorkflowAgentInvocationExecution } from "#internal/invocation/workflow-execution.js";
import { resolveInstalledPackageInfo } from "#internal/application/package.js";
import { validateMcpHttpRequest } from "#internal/mcp/http-security.js";
import {
  createMcpStreamableHttpServer,
  type McpCallToolResult,
  type McpServerTool,
} from "#internal/mcp/streamable-http-server.js";
import {
  createMcpProtectedResourceMetadata,
  createMcpResourceChallenge,
} from "#internal/mcp/protected-resource.js";
import { inputResponseSchema } from "#runtime/input/types.js";
import {
  readOAuthResourceOptions,
  routeAuth,
  type AuthFn,
  type OAuthResourceOptions,
} from "#public/channels/auth.js";
import {
  readAgentInfoRouteResponse,
  readRouteAgent,
} from "#internal/nitro/routes/channel-route-context.js";

export interface McpChannelInput {
  /** Existing eve route-auth policy. Use `none()` for explicit public access. */
  readonly auth: AuthFn<Request> | readonly AuthFn<Request>[];
  /** Streamable HTTP endpoint path. Defaults to `/mcp`. */
  readonly path?: string;
}

/** Public MCP channel exposing durable agent invocation compatibility tools. */
export type McpChannel = Channel;

/**
 * Publishes this agent as a stateless Streamable HTTP MCP server.
 *
 * This channel owns only MCP transport and durable eve invocation. It reuses
 * eve's inbound auth strategies and recognizes `oauthResource(...)` metadata
 * when OAuth discovery is needed.
 * The file containing this channel must be `agent/channels/mcp.ts`.
 */
export function mcpChannel(input: McpChannelInput): McpChannel {
  if (input?.auth === undefined) {
    throw new Error("mcpChannel requires auth. Use none() for explicit public access.");
  }
  const path = input.path ?? "/mcp";
  const oauth = readOAuthResourceOptions(input.auth);
  const routes = [
    GET(
      path,
      async (request, args) => await authenticateMcpRequest(request, args, input.auth, oauth),
    ),
    POST(
      path,
      async (request, args) => await authenticateMcpRequest(request, args, input.auth, oauth),
    ),
    DELETE(
      path,
      async (request, args) => await authenticateMcpRequest(request, args, input.auth, oauth),
    ),
  ];
  if (oauth !== undefined) {
    routes.unshift(protectedResourceMetadataRoute(oauth, path));
  }
  return defineChannel({ routes });
}

function protectedResourceMetadataRoute(options: OAuthResourceOptions, resourcePath: string) {
  const metadataPath = options.metadataPath ?? "/.well-known/oauth-protected-resource";
  return GET(metadataPath, async (request) => {
    const securityFailure = validateMcpHttpRequest(request);
    if (securityFailure !== undefined) return securityFailure;
    const resource =
      options.resource ?? new URL(resourcePath, new URL(request.url).origin).toString();
    const authorizationServers =
      options.issuer !== undefined ? [options.issuer] : options.authorizationServers;
    return Response.json(
      createMcpProtectedResourceMetadata({
        authorizationServers,
        resource,
        scopesSupported: options.scopes,
      }),
      { headers: { "cache-control": "no-store" } },
    );
  });
}

function addResourceChallenge(
  response: Response,
  request: Request,
  options: OAuthResourceOptions,
): Response {
  if (response.status !== 401 && response.status !== 403) return response;
  const metadataPath = options.metadataPath ?? "/.well-known/oauth-protected-resource";
  const publicBase = options.resource ?? new URL(request.url).origin;
  const metadataUrl = new URL(metadataPath, publicBase).toString();
  const headers = new Headers(response.headers);
  headers.append("www-authenticate", createMcpResourceChallenge(metadataUrl, options.scopes));
  return new Response(response.body, {
    headers,
    status: response.status,
    statusText: response.statusText,
  });
}

async function authenticateMcpRequest(
  request: Request,
  args: RouteHandlerArgs,
  policy: AuthFn<Request> | readonly AuthFn<Request>[],
  oauth: OAuthResourceOptions | undefined,
): Promise<Response> {
  const securityFailure = validateMcpHttpRequest(request);
  if (securityFailure !== undefined) return securityFailure;
  const auth = await routeAuth(request, policy);
  if (auth instanceof Response) {
    return oauth === undefined ? auth : addResourceChallenge(auth, request, oauth);
  }
  return await handleMcpRequest(request, args, auth);
}

async function handleMcpRequest(
  request: Request,
  args: RouteHandlerArgs,
  auth: import("#channel/types.js").SessionAuthContext,
): Promise<Response> {
  const agent = readRouteAgent(args);
  const respondWithAgentInfo = readAgentInfoRouteResponse(args);
  if (agent === undefined || respondWithAgentInfo === undefined) {
    return Response.json({ error: "MCP requires agent route context." }, { status: 500 });
  }
  const agentInfoResponse = await respondWithAgentInfo();
  if (!agentInfoResponse.ok) return agentInfoResponse;
  const agentInfo = (await agentInfoResponse.json()) as {
    readonly agent?: { readonly description?: unknown; readonly name?: unknown };
  };
  if (typeof agentInfo.agent?.name !== "string") {
    return Response.json({ error: "MCP requires compiled agent metadata." }, { status: 500 });
  }
  const description =
    typeof agentInfo.agent.description === "string" ? agentInfo.agent.description : undefined;
  const service = new AgentInvocationService(new WorkflowAgentInvocationExecution(agent, "mcp"));
  return await createMcpStreamableHttpServer({
    authenticate: async () => auth,
    name: agentInfo.agent.name,
    tools: createInvocationTools(
      service,
      description,
      auth.authenticator === "none" && auth.principalType === "anonymous",
    ),
    version: resolveInstalledPackageInfo().version,
  })(request);
}

function createInvocationTools(
  service: AgentInvocationService,
  agentDescription: string | undefined,
  publicAccess: boolean,
): readonly McpServerTool[] {
  const publicHandleDescription = publicAccess
    ? " On this public channel, the invocation ID is a bearer capability until workflow retention expires."
    : "";
  const startDescription = `Starts durable work and returns an invocation handle immediately.${publicHandleDescription}`;
  const tools: McpServerTool[] = [
    {
      definition: {
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
          readOnlyHint: false,
        },
        description:
          agentDescription === undefined
            ? startDescription
            : `${agentDescription} ${startDescription}`,
        inputSchema: {
          additionalProperties: false,
          properties: {
            message: { type: "string" },
            outputSchema: { type: "object" },
          },
          required: ["message"],
          type: "object",
        },
        name: "agent_start",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(value, context) {
        const body = record(value);
        if (typeof body.message !== "string" || body.message.length === 0)
          throw new Error("message is required.");
        const invocation = await service.create({
          auth: context.auth,
          message: body.message,
          outputSchema: asJsonObject(body.outputSchema),
        });
        return invocationResult(invocation);
      },
    },
    {
      definition: {
        annotations: {
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: true,
        },
        description: `Reads complete durable invocation state.${publicHandleDescription}`,
        inputSchema: {
          additionalProperties: false,
          properties: {
            invocationId: { type: "string" },
          },
          required: ["invocationId"],
          type: "object",
        },
        name: "agent_get",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(value, context) {
        const body = record(value);
        return invocationResult(
          await service.read({
            auth: context.auth,
            invocationId: requiredString(body.invocationId, "invocationId"),
          }),
        );
      },
    },
    {
      definition: {
        annotations: {
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: true,
          readOnlyHint: false,
        },
        description: "Answers a pending input request on a durable invocation.",
        inputSchema: {
          additionalProperties: false,
          properties: {
            invocationId: { type: "string" },
            responses: { items: { type: "object" }, type: "array" },
          },
          required: ["invocationId", "responses"],
          type: "object",
        },
        name: "agent_update",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(value, context) {
        const body = record(value);
        if (!Array.isArray(body.responses)) throw new Error("responses must be an array.");
        const responses = body.responses.map((response) => inputResponseSchema.parse(response));
        return invocationResult(
          await service.update({
            auth: context.auth,
            invocationId: requiredString(body.invocationId, "invocationId"),
            responses,
          }),
        );
      },
    },
    {
      definition: {
        annotations: {
          destructiveHint: true,
          idempotentHint: true,
          openWorldHint: false,
          readOnlyHint: false,
        },
        description:
          "Requests cancellation of a durable invocation. Read it again to observe acknowledgement.",
        inputSchema: {
          additionalProperties: false,
          properties: { invocationId: { type: "string" } },
          required: ["invocationId"],
          type: "object",
        },
        name: "agent_cancel",
        outputSchema: AGENT_INVOCATION_OUTPUT_SCHEMA,
      },
      async call(value, context) {
        const body = record(value);
        return invocationResult(
          await service.cancel({
            auth: context.auth,
            invocationId: requiredString(body.invocationId, "invocationId"),
          }),
        );
      },
    },
  ];
  return tools;
}

function invocationResult(invocation: AgentInvocation): McpCallToolResult {
  const structuredContent = parseJsonObject(invocation);
  return {
    content: [{ text: JSON.stringify(structuredContent), type: "text" }],
    structuredContent,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Expected an object.");
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

function asJsonObject(value: unknown): JsonObject | undefined {
  if (value === undefined) return undefined;
  const schema = parseJsonObject(value);
  validateOutputSchemaComplexity(schema);
  return schema;
}

const AGENT_INVOCATION_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    createdAt: { format: "date-time", type: "string" },
    error: { type: "object" },
    expiresAt: { format: "date-time", type: "string" },
    inputRequests: {
      additionalProperties: { type: "object" },
      type: "object",
    },
    invocationId: { type: "string" },
    pollAfterMs: { minimum: 0, type: "integer" },
    result: {},
    status: {
      enum: ["working", "input_required", "completed", "failed", "cancelled"],
      type: "string",
    },
  },
  required: ["createdAt", "invocationId", "status"],
  type: "object",
} as const;

const MAX_OUTPUT_SCHEMA_BYTES = 64 * 1_024;
const MAX_OUTPUT_SCHEMA_DEPTH = 32;
const MAX_OUTPUT_SCHEMA_NODES = 2_048;

function validateOutputSchemaComplexity(schema: JsonObject): void {
  if (new TextEncoder().encode(JSON.stringify(schema)).byteLength > MAX_OUTPUT_SCHEMA_BYTES) {
    throw new Error(`outputSchema must be at most ${String(MAX_OUTPUT_SCHEMA_BYTES)} bytes.`);
  }

  let nodes = 0;
  const visit = (value: import("#shared/json.js").JsonValue, depth: number): void => {
    nodes++;
    if (nodes > MAX_OUTPUT_SCHEMA_NODES) {
      throw new Error(
        `outputSchema must contain at most ${String(MAX_OUTPUT_SCHEMA_NODES)} nodes.`,
      );
    }
    if (depth > MAX_OUTPUT_SCHEMA_DEPTH) {
      throw new Error(
        `outputSchema must be at most ${String(MAX_OUTPUT_SCHEMA_DEPTH)} levels deep.`,
      );
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (value === null || typeof value !== "object") return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === "$ref" && typeof entry === "string" && !entry.startsWith("#")) {
        throw new Error("outputSchema external $ref values are not supported.");
      }
      visit(entry, depth + 1);
    }
  };

  visit(schema, 0);
}
