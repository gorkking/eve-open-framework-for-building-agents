# React Router with eve demo

A React Router framework-mode app with an embedded eve agent, integrated
through the `eveReactRouter()` Vite plugin:

```ts
import { eveReactRouter } from "eve/react-router";

export default defineConfig({
  plugins: [eveReactRouter(), reactRouter()],
});
```

The agent lives in `agent/` (instructions, tools, channels). The homepage in
`app/routes/home.tsx` is a small agent console built on eve's `useEveAgent`
React hook, with streaming, reasoning, and tool-call rendering.

## Run locally

```sh
pnpm --filter framework-react-router dev
```

## Deploy

On Vercel the app and the eve runtime deploy as one project via the
`services` declared in `vercel.json` (the React Router `web` service and the
`eve` service, plus the `/eve/v1/*` rewrite). Vercel assembles the React
Router Build Output after the framework build exits, so the plugin cannot
generate the services during the build — it validates the declaration and
fails with the exact `vercel.json` to add when it is missing. See
[the React Router frontend docs](../../../docs/guides/frontend/react-router.mdx)
for details.
