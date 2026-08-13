interface WebSocketUpgradeHooks {
  readonly upgrade: () => Response | Promise<Response>;
}

type WebSocketResponse = Response & {
  readonly crossws?: unknown;
};

interface NitroAppLike {
  fetch(request: Request): Response | Promise<Response>;
}

const NO_WEBSOCKET_ROUTE_RESPONSE = "No WebSocket route matches this request.";

/**
 * Rejects upgrades that Nitro resolved to an ordinary HTTP handler. Nitro's
 * current resolver returns empty hooks in that case, which lets crossws accept
 * the socket. Keep this compatibility guard until Nitro rejects unmatched
 * upgrades itself.
 */
export function installWebSocketUpgradeGuard(nitroApp: NitroAppLike): void {
  const fetch = nitroApp.fetch.bind(nitroApp);

  nitroApp.fetch = async (request) => {
    const response = (await fetch(request)) as WebSocketResponse;
    if (!isWebSocketUpgrade(request)) {
      return response;
    }
    if (response.crossws !== undefined) {
      void response.body?.cancel().catch(() => undefined);
      return response;
    }

    const rejection = response.ok
      ? new Response(NO_WEBSOCKET_ROUTE_RESPONSE, {
          headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
          status: 404,
        })
      : response;

    if (rejection !== response) {
      await response.body?.cancel().catch(() => undefined);
    }

    return Object.assign(rejection, {
      crossws: {
        upgrade: () => rejection,
      } satisfies WebSocketUpgradeHooks,
    });
  };
}

export default function websocketUpgradeGuardPlugin(nitroApp: NitroAppLike): void {
  installWebSocketUpgradeGuard(nitroApp);
}

function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}
