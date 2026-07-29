import {
  type CallToolRequest,
  createMcpHandler,
  Server,
} from "#compiled/@modelcontextprotocol/server/index.js";

import type { SessionAuthContext } from "#channel/types.js";

export const MCP_PROTOCOL_VERSION = "2026-07-28";
export const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";

export interface McpToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
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

    const handler = createMcpHandler(() => createServer(options, tools, auth), {
      legacy: "stateless",
    });
    return await handler.fetch(request);
  };
}

function createServer(
  options: Pick<McpStreamableHttpServerOptions, "name" | "version">,
  tools: ReadonlyMap<string, McpServerTool>,
  auth: SessionAuthContext | null,
): Server {
  const server = new Server(
    { name: options.name, version: options.version },
    { capabilities: { tools: { listChanged: false } } },
  );

  server.setRequestHandler("tools/list", async () => ({
    tools: [...tools.values()].map((tool) => tool.definition),
  }));
  server.setRequestHandler(
    "tools/call",
    async (request, context) => await callTool(request, context.mcpReq.signal, auth, tools),
  );

  return server;
}

async function callTool(
  request: CallToolRequest,
  signal: AbortSignal,
  auth: SessionAuthContext | null,
  tools: ReadonlyMap<string, McpServerTool>,
): Promise<McpCallToolResult> {
  const tool = tools.get(request.params.name);
  if (tool === undefined) return toolError(`Unknown tool: ${request.params.name}`);

  try {
    return await tool.call(request.params.arguments ?? {}, { auth, signal });
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
