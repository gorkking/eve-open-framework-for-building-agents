---
"eve": patch
---

Add the `eve/react-router` Vite plugin. `eveReactRouter()` runs an eve agent alongside a React Router framework-mode app: in development and preview it proxies eve protocol endpoints (`/eve/v1/*`) to a local eve dev server (honoring `EVE_BASE_URL`), and on Vercel builds it validates the `vercel.json` `services` declaration that deploys the app and the eve runtime as one project — failing the build with the exact `vercel.json` to add when the declaration is missing.
