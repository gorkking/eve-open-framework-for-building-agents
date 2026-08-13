import type { Hooks, ResolveHooks } from "./types.js";

export interface VercelWebSocketAdapter {
  close(code?: number, reason?: string): Promise<void>;
  handleWebUpgrade(request: Request): Promise<Response | undefined>;
  publish(topic: string, data: unknown): void;
}

export interface VercelWebSocketOptions extends Partial<Hooks> {
  readonly resolve?: ResolveHooks;
}

export default function vercelWebSocketAdapter(
  options?: VercelWebSocketOptions,
): VercelWebSocketAdapter;
