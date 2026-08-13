import {
  defineWebSocketHandler,
  H3,
  handleCors,
  type CorsOptions,
  type EventHandler,
  type H3Event,
  type HTTPError,
} from "h3";

import { EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH, EVE_HEALTH_ROUTE_PATH } from "#protocol/routes.js";
import type { ApplicationChannelRouteRegistration } from "#internal/host/application-route-registry.js";
import {
  dispatchChannelRequest,
  dispatchChannelWebSocketRequest,
} from "#internal/host/routes/channel-dispatch.js";
import { handleDevRuntimeArtifactsRequest } from "#internal/host/routes/dev-runtime-artifacts.js";
import { handleDevScheduleDispatchRequest } from "#internal/host/routes/dev-schedule-dispatch.js";
import healthHandler from "#internal/host/routes/health.js";
import { handleHomePageRequest } from "#internal/host/routes/index.js";
import type {
  DevelopmentApplicationArtifactsConfig,
  ApplicationArtifactsConfig,
} from "#internal/host/routes/runtime-artifacts.js";

export interface ApplicationRouterOptions {
  readonly agentName: string;
  readonly artifacts: ApplicationArtifactsConfig;
  readonly channels: readonly ApplicationChannelRouteRegistration[];
  readonly development?: {
    readonly artifacts: DevelopmentApplicationArtifactsConfig;
  };
  readonly cron?: {
    readonly handler: (request: Request) => Response | Promise<Response>;
    readonly route: string;
  };
  readonly workflow?: {
    readonly handler: (request: Request) => Response | Promise<Response>;
    readonly route: string;
  };
}

/** Creates the complete eve request router without a framework-owned host. */
export function createApplicationRouter(options: ApplicationRouterOptions): H3 {
  const app = new H3({
    debug: options.artifacts.kind === "development",
    onError: (error, event) => handleApplicationError(error, event, options.artifacts.kind),
    silent: true,
  });
  const webSocketRoutes = new Map(
    options.channels
      .filter((registration) => registration.method === "WEBSOCKET")
      .map((registration) => [registration.route, registration] as const),
  );
  const httpGetRoutes = new Set([
    "/",
    EVE_HEALTH_ROUTE_PATH,
    ...(options.development === undefined ? [] : [EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH]),
    ...options.channels
      .filter((registration) => registration.method === "GET")
      .map((registration) => registration.route),
  ]);

  registerGetRoute(
    app,
    "/",
    (event) => handleHomePageRequest({ agentName: options.agentName }, event.req),
    webSocketRoutes.get("/"),
    options,
  );
  registerGetRoute(
    app,
    EVE_HEALTH_ROUTE_PATH,
    healthHandler,
    webSocketRoutes.get(EVE_HEALTH_ROUTE_PATH),
    options,
  );
  app.head(EVE_HEALTH_ROUTE_PATH, healthHandler);

  registerChannelRoutes(app, options, webSocketRoutes, httpGetRoutes);

  if (options.cron !== undefined) {
    const cron = options.cron;
    app.all(cron.route, (event) => cron.handler(event.req));
  }

  if (options.development !== undefined) {
    const development = options.development;
    registerGetRoute(
      app,
      EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH,
      () => handleDevRuntimeArtifactsRequest({ appRoot: development.artifacts.appRoot }),
      webSocketRoutes.get(EVE_DEV_RUNTIME_ARTIFACTS_ROUTE_PATH),
      options,
    );
    app.post("/eve/v1/dev/schedules/:scheduleId", (event) =>
      handleDevScheduleDispatchRequest(development.artifacts, event.req),
    );
  }

  if (options.workflow !== undefined) {
    const workflow = options.workflow;
    app.post(workflow.route, (event) => workflow.handler(event.req));
  }

  return app;
}

function registerChannelRoutes(
  app: H3,
  options: ApplicationRouterOptions,
  webSocketRoutes: ReadonlyMap<string, ApplicationChannelRouteRegistration>,
  httpGetRoutes: ReadonlySet<string>,
): void {
  const preflightRoutes = new Set<string>();

  for (const registration of options.channels) {
    const routeKey = createChannelRouteKey(registration);

    if (registration.method === "WEBSOCKET") {
      if (httpGetRoutes.has(registration.route)) {
        continue;
      }
      app.all(registration.route, createWebSocketRouteHandler(registration, options));
      continue;
    }

    const cors = registration.cors;
    if (cors !== undefined && !preflightRoutes.has(registration.route)) {
      preflightRoutes.add(registration.route);
      app.options(registration.route, (event) => {
        const response = handleCors(event, cors as CorsOptions);
        return response === false ? new Response(null, { status: 204 }) : response;
      });
    }

    const handler = (event: H3Event) => {
      if (cors !== undefined) {
        const response = handleCors(event, cors as CorsOptions);
        if (response !== false) {
          return response;
        }
      }
      return dispatchChannelRequest(event, routeKey, options.artifacts);
    };

    if (registration.method === "GET") {
      registerGetRoute(
        app,
        registration.route,
        handler,
        webSocketRoutes.get(registration.route),
        options,
      );
    } else {
      app.on(registration.method, registration.route, handler);
    }
  }
}

function registerGetRoute(
  app: H3,
  route: string,
  handler: EventHandler,
  webSocketRegistration: ApplicationChannelRouteRegistration | undefined,
  options: ApplicationRouterOptions,
): void {
  app.get(
    route,
    webSocketRegistration === undefined
      ? handler
      : createWebSocketRouteHandler(webSocketRegistration, options, handler),
  );
}

function createWebSocketRouteHandler(
  registration: ApplicationChannelRouteRegistration,
  options: ApplicationRouterOptions,
  httpHandler?: EventHandler,
) {
  const routeKey = createChannelRouteKey(registration);
  const hooks = (event: H3Event) =>
    dispatchChannelWebSocketRequest(event, routeKey, options.artifacts);
  return httpHandler === undefined
    ? defineWebSocketHandler(hooks)
    : defineWebSocketHandler(hooks, httpHandler);
}

function createChannelRouteKey(registration: ApplicationChannelRouteRegistration): string {
  return `${registration.method.toUpperCase()} ${registration.route}`;
}

function handleApplicationError(
  error: HTTPError,
  _event: H3Event,
  kind: ApplicationArtifactsConfig["kind"],
): Response {
  if (kind === "development") {
    return Response.json(
      {
        error: true,
        message: error.message,
        stack: error.stack,
        status: error.status,
        statusText: error.statusText,
        unhandled: error.unhandled,
      },
      { status: error.status, statusText: error.statusText },
    );
  }

  if (error.unhandled) {
    return Response.json({ error: true, status: 500, unhandled: true }, { status: 500 });
  }

  return Response.json(error.toJSON(), {
    headers: error.headers,
    status: error.status,
    statusText: error.statusText,
  });
}
