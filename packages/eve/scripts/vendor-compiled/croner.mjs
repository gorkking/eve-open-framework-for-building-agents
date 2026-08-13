import { fileURLToPath } from "node:url";

import { loadDeclaration } from "./_shared.mjs";

const wrapperEntry = fileURLToPath(new URL("./entries/croner.mjs", import.meta.url));

/** Vendors only the timer primitive used by eve's process-local schedule runner. */
export default {
  packageName: "croner",
  compiledPath: "croner",
  bundling: "standalone",
  requireLicense: true,
  validateBundledPackages: true,
  entries: [
    {
      input: wrapperEntry,
      outputPath: "index",
      declaration: await loadDeclaration("croner.d.ts"),
    },
  ],
};
