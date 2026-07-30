export default {
  packageName: "@modelcontextprotocol/server",
  compiledPath: "@modelcontextprotocol/server",
  chunkGroup: "workflow",
  entries: [
    {
      entry: "dist/index.mjs",
      outputPath: "index",
      declaration: `
export interface CallToolRequest {
  readonly params: {
    readonly arguments?: Readonly<Record<string, unknown>>;
    readonly name: string;
  };
}

export interface McpRequestHandlerExtra {
  readonly mcpReq: {
    readonly signal: AbortSignal;
  };
}

export interface McpToolAnnotations {
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
  readonly readOnlyHint?: boolean;
}

export interface StandardSchemaWithJSON<T = unknown> {
  readonly "~standard": unknown;
}

export declare class Server {
  constructor(info: { readonly name: string; readonly version: string }, options?: {
    readonly capabilities?: Readonly<Record<string, unknown>>;
  });
  setRequestHandler<Result>(
    method: "tools/list",
    handler: (
      request: { readonly params: Readonly<Record<string, unknown>> },
      context: McpRequestHandlerExtra,
    ) => Result | Promise<Result>,
  ): void;
  setRequestHandler<Result>(
    method: "tools/call",
    handler: (
      request: CallToolRequest,
      context: McpRequestHandlerExtra,
    ) => Result | Promise<Result>,
  ): void;
}

export declare class McpServer {
  constructor(info: { readonly name: string; readonly version: string }, options?: {
    readonly capabilities?: Readonly<Record<string, unknown>>;
  });
  registerTool<T = unknown>(
    name: string,
    config: {
      readonly annotations?: McpToolAnnotations;
      readonly description?: string;
      readonly inputSchema: StandardSchemaWithJSON<T>;
      readonly outputSchema?: StandardSchemaWithJSON;
    },
    callback: (
      input: T,
      context: McpRequestHandlerExtra,
    ) => unknown | Promise<unknown>,
  ): void;
}

export interface McpRequestContext {
  readonly era: "legacy" | "modern";
  readonly requestInfo: Request;
}

export interface McpHandler {
  fetch(request: Request): Promise<Response>;
}

export declare function fromJsonSchema<T = unknown>(
  schema: Readonly<Record<string, unknown>>,
): StandardSchemaWithJSON<T>;

export declare function hostHeaderValidationResponse(
  request: Request,
  allowedHostnames: readonly string[],
): Response | undefined;

export declare function originValidationResponse(
  request: Request,
  allowedOriginHostnames: readonly string[],
): Response | undefined;

export declare function createMcpHandler(
  factory: (context: McpRequestContext) => McpServer | Server | Promise<McpServer | Server>,
  options?: {
    readonly legacy?: "reject" | "stateless";
    readonly onerror?: (error: Error) => void;
    readonly responseMode?: "auto" | "json" | "stream";
  },
): McpHandler;
`,
    },
  ],
  platform: "neutral",
};
