import { dirname, relative } from "node:path/posix";

import {
  createPrependedLineSourceMap,
  type PrependedLineSourceMap,
} from "#internal/bundler/prepended-line-source-map.js";

/**
 * Name of the emitted chunk that registers authored instrumentation.
 * Underscore-prefixed to match Nitro's convention for generated output that
 * is not a route.
 */
export const INSTRUMENTATION_PRELOAD_CHUNK_FILE_NAME = "_eve-instrumentation.mjs";

/** Bundler hook context this plugin needs from Rollup and Rolldown. */
interface InstrumentationPreloadPluginContext {
  emitFile(file: { type: "chunk"; id: string; fileName: string }): string;
  getFileName(referenceId: string): string;
}

interface RenderedChunk {
  readonly fileName?: string;
  readonly isEntry?: boolean;
}

/** The subset of the rolldown/rollup plugin shape this plugin implements. */
export interface InstrumentationPreloadBundlerPlugin {
  readonly name: string;
  buildStart(this: InstrumentationPreloadPluginContext): void;
  renderChunk(
    this: InstrumentationPreloadPluginContext,
    code: string,
    chunk?: RenderedChunk,
  ): { code: string; map: PrependedLineSourceMap } | null;
}

/**
 * Resolves the specifier an entry chunk uses to import the preload chunk.
 * Both names are bundler-relative and always use forward slashes.
 */
function resolvePreloadSpecifier(chunkFileName: string, preloadFileName: string): string {
  const chunkDirectory = dirname(chunkFileName);
  const relativePath =
    chunkDirectory === "." ? preloadFileName : relative(chunkDirectory, preloadFileName);

  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

/**
 * Creates a bundler plugin that runs authored instrumentation before any
 * other module in the bundle.
 *
 * Registering instrumentation from a Nitro plugin is too late to patch
 * anything: plugin bodies are inlined into the bundled entry, while the
 * entry's dependencies — including externals such as `pg` — are hoisted
 * static imports above them. ESM evaluates every import before any body
 * code, so a module loaded that way is already resolved by the time an
 * OpenTelemetry instrumentation registers its require hook. Reordering the
 * Nitro plugin list cannot fix that, because the ordering is a property of
 * import hoisting rather than of the plugin list.
 *
 * So the instrumentation module is emitted as its own chunk and imported on
 * the entry's first line, ahead of every hoisted import. Compatible with
 * both Rollup and Rolldown.
 */
export function createInstrumentationPreloadPlugin(
  instrumentationModulePath: string,
): InstrumentationPreloadBundlerPlugin {
  let preloadReferenceId: string | undefined;

  return {
    name: "eve-instrumentation-preload",
    buildStart() {
      preloadReferenceId = this.emitFile({
        type: "chunk",
        id: instrumentationModulePath,
        fileName: INSTRUMENTATION_PRELOAD_CHUNK_FILE_NAME,
      });
    },
    renderChunk(code, chunk) {
      if (preloadReferenceId === undefined || chunk?.isEntry !== true) {
        return null;
      }

      // The preload is emitted as an entry chunk of its own; it must not
      // import itself.
      const preloadFileName = this.getFileName(preloadReferenceId);
      if (chunk.fileName === undefined || chunk.fileName === preloadFileName) {
        return null;
      }

      const specifier = resolvePreloadSpecifier(chunk.fileName, preloadFileName);
      const importLine = `import ${JSON.stringify(specifier)};`;

      // eve hands the same plugin instance to both the Rollup and the
      // Rolldown Nitro config, so `renderChunk` can run more than once for
      // one chunk. Prepending twice would be harmless at runtime but noisy
      // in the output, and it would offset the source map twice.
      if (code.startsWith(importLine)) {
        return null;
      }

      return {
        code: `${importLine}\n${code}`,
        map: createPrependedLineSourceMap({
          insertedLineCount: 1,
          source: chunk.fileName,
          sourceContent: code,
        }),
      };
    },
  };
}
