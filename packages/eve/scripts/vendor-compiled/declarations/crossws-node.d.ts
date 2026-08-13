import type { Hooks, ResolveHooks } from "./types.js";

export interface NodeServer {
  readonly url?: string;
  close(closeActiveConnections?: boolean): Promise<void>;
  ready(): Promise<NodeServer>;
  serve(): void | Promise<NodeServer>;
}

export interface NodeServeOptions {
  readonly fetch: (request: Request) => Response | Promise<Response>;
  readonly gracefulShutdown?: boolean;
  readonly hostname?: string;
  readonly manual?: boolean;
  readonly port?: number | string;
  readonly silent?: boolean;
  readonly websocket?: Partial<Hooks> & {
    readonly resolve?: ResolveHooks;
  };
}

export declare function serve(options: NodeServeOptions): NodeServer;
