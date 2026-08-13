import {
  createMcpHandler,
  fromJsonSchema,
  McpServer,
  type McpToolAnnotations,
} from "#compiled/@modelcontextprotocol/server/index.js";

import type { SessionAuthContext } from "#channel/types.js";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";

export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly annotations?: McpToolAnnotations;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

export interface McpCallToolResult {
  readonly content: readonly McpContent[];
  readonly isError?: boolean;
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

export type McpContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "resource_link"; readonly name: string; readonly uri: string };

export interface McpServerTool {
  readonly definition: McpToolDefinition;
  call(
    input: unknown,
    context: { readonly auth: SessionAuthContext | null; readonly signal: AbortSignal },
  ): Promise<McpCallToolResult>;
}

export interface McpStreamableHttpServerOptions {
  readonly name: string;
  readonly version: string;
  readonly tools: readonly McpServerTool[];
  authenticate(request: Request): Promise<SessionAuthContext | null | Response>;
}

/**
 * Creates a dual-era, stateless MCP HTTP request handler.
 *
 * Current clients use MCP 2026-07-28's per-request envelope. Older clients
 * fall back to the SDK's stateless 2025 Streamable HTTP implementation.
 */
export function createMcpStreamableHttpServer(
  options: McpStreamableHttpServerOptions,
): (request: Request) => Promise<Response> {
  const tools = new Map(options.tools.map((tool) => [tool.definition.name, tool]));
  if (tools.size !== options.tools.length) throw new Error("MCP tool names must be unique.");

  return async (request) => {
    const auth = await options.authenticate(request);
    if (auth instanceof Response) return auth;

    const preflight = await preflightModernRequest(request);
    if (preflight.response !== undefined) return preflight.response;

    const handler = createMcpHandler(() => createServer(options, tools, auth), {
      legacy: "stateless",
    });
    return await handler.fetch(
      request,
      preflight.parsedBody === undefined ? undefined : { parsedBody: preflight.parsedBody },
    );
  };
}

interface ModernRequestPreflight {
  readonly parsedBody?: unknown;
  readonly response?: Response;
}

/**
 * The SDK currently checks MCP-Protocol-Version only when the header is
 * present. MCP 2026-07-28 requires it on every modern POST, so reject the
 * missing-header case here until the upstream handler does:
 * modelcontextprotocol/typescript-sdk#2589.
 */
async function preflightModernRequest(request: Request): Promise<ModernRequestPreflight> {
  if (request.method.toUpperCase() !== "POST" || request.headers.has("mcp-protocol-version")) {
    return {};
  }

  let parsedBody: unknown;
  try {
    parsedBody = await request.clone().json();
  } catch {
    return {};
  }

  if (!claimsCurrentProtocolVersion(parsedBody)) {
    return { parsedBody };
  }

  const earlierFailure = await probeEarlierValidationFailure(request, parsedBody);
  if (earlierFailure !== undefined) {
    return { parsedBody, response: earlierFailure };
  }

  return {
    parsedBody,
    response: headerMismatchResponse(parsedBody),
  };
}

function claimsCurrentProtocolVersion(body: unknown): boolean {
  return (
    isPlainRecord(body) &&
    isPlainRecord(body.params) &&
    isPlainRecord(body.params._meta) &&
    body.params._meta["io.modelcontextprotocol/protocolVersion"] === MCP_PROTOCOL_VERSION
  );
}

function isPlainRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Ask a side-effect-free SDK handler to apply the validation rungs that
 * precede required standard-header presence. Preserve those errors; otherwise
 * the valid current-revision envelope is ready for the missing-header error.
 */
async function probeEarlierValidationFailure(
  request: Request,
  parsedBody: unknown,
): Promise<Response | undefined> {
  const headers = new Headers(request.headers);
  headers.set("mcp-protocol-version", MCP_PROTOCOL_VERSION);
  const probeRequest = new Request(request.clone(), { headers });
  const probe = createMcpHandler(() => new McpServer({ name: "eve-mcp-preflight", version: "0" }), {
    legacy: "reject",
  });
  try {
    const response = await probe.fetch(probeRequest, { parsedBody });
    if (response.status === 406 || response.status === 415) {
      return response;
    }
    if (response.status === 400) {
      const body = (await response
        .clone()
        .json()
        .catch(() => undefined)) as { readonly error?: { readonly code?: unknown } } | undefined;
      if (
        body?.error?.code === -32_700 ||
        body?.error?.code === -32_600 ||
        body?.error?.code === -32_602 ||
        body?.error?.code === -32_022
      ) {
        return response;
      }
    }
    await response.body?.cancel();
    return undefined;
  } finally {
    await probe.close().catch(() => {});
  }
}

function headerMismatchResponse(body: unknown): Response {
  const mismatchBody =
    "the body carries a modern MCP envelope but the required MCP-Protocol-Version header is absent";
  return Response.json(
    {
      error: {
        code: -32_020,
        data: {
          mismatch: {
            body: mismatchBody,
            header: "(missing)",
          },
        },
        message: `Bad Request: the request headers and body disagree: ${mismatchBody}`,
      },
      id: readJsonRpcRequestId(body),
      jsonrpc: "2.0",
    },
    { status: 400 },
  );
}

function readJsonRpcRequestId(body: unknown): string | number | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const id = Reflect.get(body, "id");
  return typeof id === "string" || typeof id === "number" ? id : null;
}

function createServer(
  options: Pick<McpStreamableHttpServerOptions, "name" | "version">,
  tools: ReadonlyMap<string, McpServerTool>,
  auth: SessionAuthContext | null,
): McpServer {
  const server = new McpServer(
    { name: options.name, version: options.version },
    { capabilities: { tools: { listChanged: false } } },
  );

  for (const tool of tools.values()) {
    server.registerTool(
      tool.definition.name,
      {
        ...(tool.definition.annotations === undefined
          ? {}
          : { annotations: tool.definition.annotations }),
        ...(tool.definition.description === undefined
          ? {}
          : { description: tool.definition.description }),
        inputSchema: fromJsonSchema(tool.definition.inputSchema),
        ...(tool.definition.outputSchema === undefined
          ? {}
          : { outputSchema: fromJsonSchema(tool.definition.outputSchema) }),
      },
      async (input, context) => await callTool(tool, input, context.mcpReq.signal, auth),
    );
  }

  return server;
}

async function callTool(
  tool: McpServerTool,
  input: unknown,
  signal: AbortSignal,
  auth: SessionAuthContext | null,
): Promise<McpCallToolResult> {
  try {
    return await tool.call(input, { auth, signal });
  } catch (error) {
    return toolError(error instanceof Error ? error.message : "Tool call failed.");
  }
}

function toolError(message: string): McpCallToolResult {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
  };
}
