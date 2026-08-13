import type { Hooks } from "#compiled/crossws/types.js";

import type { ApplicationFetch } from "#internal/host/application-task-tracker.js";

interface ApplicationWebSocketResponse extends Response {
  readonly crossws?: Partial<Hooks> | Promise<Partial<Hooks>>;
}

/**
 * Resolves only hooks explicitly attached by an eve WebSocket route.
 *
 * CrossWS's default fetch resolver treats any successful HTTP response as an
 * upgrade without hooks. A host with one WebSocket channel would therefore
 * accept upgrades on every successful HTTP route unless eve owns this check.
 */
export function createApplicationWebSocketResolver(
  fetch: ApplicationFetch,
): (request: Request) => Promise<Partial<Hooks>> {
  return async (request) => {
    const response = (await fetch(request)) as ApplicationWebSocketResponse;
    if (response.crossws !== undefined) {
      void response.body?.cancel().catch(() => undefined);
      return response.crossws;
    }

    if (!response.ok && response.status !== 101) {
      return {
        upgrade: () => response,
      };
    }

    void response.body?.cancel().catch(() => undefined);
    return {
      upgrade: () =>
        new Response("No WebSocket route matches this request.", {
          headers: { "cache-control": "no-store" },
          status: 404,
        }),
    };
  };
}
