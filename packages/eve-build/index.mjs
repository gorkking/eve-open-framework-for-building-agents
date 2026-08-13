import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

export { build, copyPublicAssets, createNitro, prepare, prerender } from "nitro/builder";

export const EVE_BUILD_ENGINE_PROTOCOL = 1;

const require = createRequire(import.meta.url);
const nitroRequire = createRequire(require.resolve("nitro/package.json"));

let rolldownPromise;
let rolldownParseAstPromise;

function loadRolldown() {
  rolldownPromise ??= import(pathToFileURL(nitroRequire.resolve("rolldown")).href);
  return rolldownPromise;
}

function loadRolldownParseAst() {
  rolldownParseAstPromise ??= import(pathToFileURL(nitroRequire.resolve("rolldown/parseAst")).href);
  return rolldownParseAstPromise;
}

export async function buildWithRolldown(options) {
  const { build } = await loadRolldown();
  return await build(options);
}

export async function parseWithRolldown(sourceText, options, filename) {
  const { parseAst } = await loadRolldownParseAst();
  return parseAst(sourceText, options, filename);
}

export function resolveNitroDependency(specifier) {
  return nitroRequire.resolve(specifier);
}
