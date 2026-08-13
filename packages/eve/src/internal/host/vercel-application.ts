import vercelWebSocketAdapter from "crossws/adapters/vercel";

import type { ApplicationFetch } from "#internal/host/application-task-tracker.js";
import { createApplicationWebSocketResolver } from "#internal/host/application-websocket.js";

export interface VercelApplicationContext {
  readonly waitUntil?: (task: Promise<unknown>) => void;
}

export interface CreateVercelApplicationHandlerOptions {
  readonly fetch: ApplicationFetch;
  readonly websocket?: boolean;
}

export interface VercelApplicationHandler {
  fetch(request: Request, context?: VercelApplicationContext): Promise<Response>;
}

interface VercelServerRequest extends Request {
  ip?: string;
  runtime?: {
    name: string;
    vercel?: { context: VercelApplicationContext | undefined };
    [key: string]: unknown;
  };
  waitUntil?: (task: Promise<unknown>) => void;
}

/** Creates the fetch-style entry exported by a Vercel server function. */
export function createVercelApplicationHandler(
  options: CreateVercelApplicationHandlerOptions,
): VercelApplicationHandler {
  const websocket = options.websocket
    ? vercelWebSocketAdapter({
        resolve: createApplicationWebSocketResolver(options.fetch),
      })
    : undefined;

  return {
    async fetch(request, context) {
      const serverRequest = request as VercelServerRequest;
      attachVercelRequestContext(serverRequest, context);

      if (
        websocket !== undefined &&
        serverRequest.headers.get("upgrade")?.toLowerCase() === "websocket"
      ) {
        const response = await websocket.handleWebUpgrade(serverRequest);
        if (response !== undefined) {
          return response;
        }
      }

      return await options.fetch(serverRequest);
    },
  };
}

function attachVercelRequestContext(
  request: VercelServerRequest,
  context: VercelApplicationContext | undefined,
): void {
  request.runtime ??= { name: "vercel" };
  request.runtime.vercel = { context };

  let ip: string | undefined;
  let ipResolved = false;
  Object.defineProperty(request, "ip", {
    configurable: true,
    get() {
      if (!ipResolved) {
        ipResolved = true;
        ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || undefined;
      }
      return ip;
    },
  });

  if (context?.waitUntil !== undefined) {
    request.waitUntil = context.waitUntil;
  }
}
