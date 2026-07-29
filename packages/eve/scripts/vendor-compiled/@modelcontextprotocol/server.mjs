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

export interface McpRequestContext {
  readonly era: "legacy" | "modern";
  readonly requestInfo: Request;
}

export interface McpHandler {
  fetch(request: Request): Promise<Response>;
}

export declare function createMcpHandler(
  factory: (context: McpRequestContext) => Server | Promise<Server>,
  options?: {
    readonly legacy?: "reject" | "stateless";
    readonly responseMode?: "auto" | "json" | "stream";
  },
): McpHandler;
`,
    },
  ],
  platform: "neutral",
};
