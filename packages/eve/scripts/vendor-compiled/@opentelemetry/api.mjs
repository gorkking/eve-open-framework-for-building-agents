import { createRequire } from "node:module";

import { loadDeclaration } from "../_shared.mjs";

const require = createRequire(import.meta.url);
const commonJsEntry = require.resolve("@opentelemetry/api");

// @vercel/otel loads the CommonJS entry, so bare imports must share that API proxy.
const preserveApiSingleton = {
  name: "eve:preserve-opentelemetry-api-singleton",
  resolveId(source) {
    return source === "@opentelemetry/api" ? commonJsEntry : null;
  },
};

export default {
  packageName: "@opentelemetry/api",
  compiledPath: "@opentelemetry/api",
  chunkGroup: "workflow",
  entry: "build/esm/index.js",
  declaration: await loadDeclaration("@opentelemetry/api.d.ts"),
  plugins: [preserveApiSingleton],
};
