import { fileURLToPath } from "node:url";

import { loadDeclaration } from "./_shared.mjs";

const wrapperEntry = fileURLToPath(new URL("./entries/h3.mjs", import.meta.url));

/** Vendors the three H3 router primitives used by the generated application host. */
export default {
  packageName: "h3",
  compiledPath: "h3",
  attributionFiles: [
    {
      source: "dist/THIRD-PARTY-LICENSES.md",
      output: "THIRD-PARTY-LICENSES.md",
    },
  ],
  bundledPackages: ["rou3", "srvx"],
  chunkGroup: "host-runtime",
  requireLicense: true,
  validateBundledPackages: true,
  entries: [
    {
      input: wrapperEntry,
      outputPath: "index",
      declaration: await loadDeclaration("h3.d.ts"),
    },
  ],
};
