import { isAbsolute, resolve } from "node:path";

import type { Plugin, UserConfig } from "vite";

import { EVE_ROUTE_PREFIX } from "#protocol/routes.js";
import {
  ensureEveVercelServicesConfig,
  type EnsureEveVercelServicesConfigResult,
} from "#shared/vercel-services.js";

import { EVE_BASE_URL_ENV, resolveSharedEveDevServer } from "./dev-server.js";
import { normalizeOrigin } from "./routing.js";

/**
 * Options for the eve React Router Vite plugin.
 */
export interface EveReactRouterPluginOptions {
  /**
   * Path to the eve application root, relative to the React Router project
   * root unless absolute. Defaults to the React Router project root.
   */
  readonly eveRoot?: string;
  /**
   * Command that builds the eve app inside the eve Vercel service. Defaults to
   * running the installed eve binary from the React Router app's dependencies
   * (`node <path-to>/eve/bin/eve.js build`).
   */
  readonly eveBuildCommand?: string;
}

function resolveApplicationRoot(reactRouterRoot: string, appPath: string | undefined): string {
  if (appPath === undefined || appPath.length === 0) {
    return reactRouterRoot;
  }
  return isAbsolute(appPath) ? appPath : resolve(reactRouterRoot, appPath);
}

function mergeProxyConfig(
  existingProxy: NonNullable<UserConfig["server"]>["proxy"],
  eveTarget: string,
): NonNullable<UserConfig["server"]>["proxy"] {
  return {
    ...existingProxy,
    [EVE_ROUTE_PREFIX]: {
      changeOrigin: true,
      target: eveTarget,
    },
  };
}

async function resolveEveDevProxyTarget(appRoot: string): Promise<string> {
  const configuredEveBaseUrl = process.env[EVE_BASE_URL_ENV]?.trim();
  if (configuredEveBaseUrl && configuredEveBaseUrl.length > 0) {
    return normalizeOrigin(configuredEveBaseUrl);
  }

  return (await resolveSharedEveDevServer(appRoot)).origin;
}

function createVercelServicesExample(
  generated: Extract<EnsureEveVercelServicesConfigResult, { mode: "generated" }>,
): string {
  return JSON.stringify(
    {
      services: {
        web: { root: ".", framework: "react-router" },
        ...generated.services,
      },
      rewrites: [
        { source: `${EVE_ROUTE_PREFIX}/(.*)`, destination: { service: "eve" } },
        { source: "/(.*)", destination: { service: "web" } },
      ],
    },
    null,
    2,
  );
}

/**
 * Vite plugin for running an eve agent alongside a React Router framework-mode
 * app.
 *
 * In development and local preview, `eveReactRouter` proxies eve protocol
 * endpoints to a local eve server. It resolves the server in order: the
 * `EVE_BASE_URL` env var if set, then a healthy shared eve dev server already
 * running for the app, then a freshly spawned `eve dev --no-ui --port 0`.
 *
 * On Vercel builds the eve service must be declared in `vercel.json`
 * `services`: Vercel assembles the React Router Build Output after the
 * framework build exits, so there is no build hook where eve could merge a
 * generated service. The plugin validates the declaration and fails the build
 * with the exact `vercel.json` to add when it is missing.
 */
export function eveReactRouter(options: EveReactRouterPluginOptions = {}): Plugin {
  return {
    enforce: "post",
    name: "eve:react-router",
    async config(config, env) {
      const reactRouterRoot =
        config.root === undefined ? process.cwd() : resolve(process.cwd(), config.root);
      const appRoot = resolveApplicationRoot(reactRouterRoot, options.eveRoot);

      if (env.command === "build" && process.env.VERCEL) {
        const configured = await ensureEveVercelServicesConfig({
          appRoot,
          eveBuildCommand: options.eveBuildCommand,
          frameworkName: "React Router",
          hostRoot: reactRouterRoot,
        });

        if (configured.mode === "generated") {
          throw new Error(
            "Vercel assembles the React Router Build Output after the framework build exits, so eve cannot generate Vercel services during a React Router build. Declare the services in vercel.json instead — this React Router app, the eve service, and the eve transport rewrite:\n" +
              `${createVercelServicesExample(configured)}\n` +
              "Then set the project's Framework Preset to Services.",
          );
        }

        return {};
      }

      // React Router's config loader instantiates the Vite config in serve
      // mode during builds, so a Vercel build would otherwise spawn an eve dev
      // server inside the build container.
      if (env.command !== "serve" || process.env.VERCEL) {
        return {};
      }

      const proxyTarget = await resolveEveDevProxyTarget(appRoot);

      if (env.isPreview) {
        return {
          preview: {
            proxy: mergeProxyConfig(config.preview?.proxy, proxyTarget),
          },
        };
      }

      return {
        server: {
          proxy: mergeProxyConfig(config.server?.proxy, proxyTarget),
        },
      };
    },
  };
}
