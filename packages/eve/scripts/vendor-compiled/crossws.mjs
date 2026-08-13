import { fileURLToPath } from "node:url";

import { loadDeclaration } from "./_shared.mjs";

const entry = (name) => fileURLToPath(new URL(`./entries/${name}.mjs`, import.meta.url));

/**
 * Vendors eve's Node and Vercel CrossWS adapters as one shared graph. srvx is
 * bundled into both adapter surfaces, so its resolved version and license are
 * tracked even though eve never imports srvx directly.
 */
export default {
  packageName: "crossws",
  compiledPath: "crossws",
  bundledPackages: ["srvx"],
  chunkGroup: "host-runtime",
  requireLicense: true,
  validateBundledPackages: true,
  entries: [
    {
      input: entry("crossws-node"),
      outputPath: "node",
      declaration: await loadDeclaration("crossws-node.d.ts"),
    },
    {
      input: entry("crossws-vercel"),
      outputPath: "vercel",
      declaration: await loadDeclaration("crossws-vercel.d.ts"),
    },
    {
      input: entry("crossws-types"),
      outputPath: "types",
      declaration: await loadDeclaration("crossws-types.d.ts"),
    },
  ],
};
