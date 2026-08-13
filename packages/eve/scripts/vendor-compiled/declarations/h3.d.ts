import type { Hooks } from "#compiled/crossws/types.js";

type MaybePromise<T> = T | Promise<T>;

export interface H3Request extends Request {
  readonly ip?: string;
}

export interface H3EventContext {
  readonly params?: Record<string, string>;
  readonly [key: string]: unknown;
}

export interface H3Event {
  readonly context: H3EventContext;
  readonly req: H3Request;
  waitUntil(task: Promise<unknown>): void;
}

export type EventHandler = (event: H3Event) => MaybePromise<unknown>;

export interface CorsOptions {
  readonly [key: string]: unknown;
}

export interface HTTPError extends Error {
  readonly headers: Headers | undefined;
  readonly status: number;
  readonly statusText: string | undefined;
  readonly unhandled: boolean | undefined;
  toJSON(): Record<string, unknown>;
}

export interface H3Config {
  readonly debug?: boolean;
  readonly onError?: (error: HTTPError, event: H3Event) => MaybePromise<unknown>;
  readonly silent?: boolean;
}

export declare class H3 {
  readonly fetch: (request: Request) => Response | Promise<Response>;

  constructor(config?: H3Config);

  all(route: string, handler: EventHandler): this;
  get(route: string, handler: EventHandler): this;
  head(route: string, handler: EventHandler): this;
  on(method: string, route: string, handler: EventHandler): this;
  options(route: string, handler: EventHandler): this;
  post(route: string, handler: EventHandler): this;
  request(input: RequestInfo | URL, init?: RequestInit): Response | Promise<Response>;
}

export declare function defineWebSocketHandler(hooks: Partial<Hooks>): EventHandler;
export declare function defineWebSocketHandler(
  hooks: (event: H3Event) => MaybePromise<Partial<Hooks>>,
): EventHandler;
export declare function defineWebSocketHandler(
  hooks: Partial<Hooks>,
  httpHandler: EventHandler,
): EventHandler;
export declare function defineWebSocketHandler(
  hooks: (event: H3Event) => MaybePromise<Partial<Hooks>>,
  httpHandler: EventHandler,
): EventHandler;

export declare function handleCors(event: H3Event, options: CorsOptions): false | Response;
