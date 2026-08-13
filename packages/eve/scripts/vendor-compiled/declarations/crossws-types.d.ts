import type {
  WebSocketMessage,
  WebSocketPeer,
  WebSocketUpgradeRequest,
  WebSocketUpgradeResult,
} from "#channel/routes.js";

type MaybePromise<T> = T | Promise<T>;

export interface Hooks {
  close(peer: WebSocketPeer, details: { code?: number; reason?: string }): MaybePromise<void>;
  drain(peer: WebSocketPeer): MaybePromise<void>;
  error(peer: WebSocketPeer, error: Error): MaybePromise<void>;
  message(peer: WebSocketPeer, message: WebSocketMessage): MaybePromise<void>;
  open(peer: WebSocketPeer): MaybePromise<void>;
  ping(peer: WebSocketPeer, data: Uint8Array): MaybePromise<void>;
  pong(peer: WebSocketPeer, data: Uint8Array): MaybePromise<void>;
  upgrade(request: WebSocketUpgradeRequest): MaybePromise<WebSocketUpgradeResult>;
}

export type ResolveHooks = (request: Request) => MaybePromise<Partial<Hooks>>;
