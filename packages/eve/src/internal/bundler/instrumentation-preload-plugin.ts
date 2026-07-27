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
  return {
    name: "eve-instrumentation-preload",
    buildStart() {
      // An explicit `fileName` is emitted verbatim, so the chunk's name is
      // the constant rather than something to read back with `getFileName`.
      this.emitFile({
        type: "chunk",
        id: instrumentationModulePath,
        fileName: INSTRUMENTATION_PRELOAD_CHUNK_FILE_NAME,
      });
    },
    renderChunk(code, chunk) {
      // The preload is emitted as an entry chunk of its own; it must not
      // import itself.
      if (
        chunk?.isEntry !== true ||
        chunk.fileName === undefined ||
        chunk.fileName === INSTRUMENTATION_PRELOAD_CHUNK_FILE_NAME
      ) {
        return null;
      }

      const specifier = resolvePreloadSpecifier(
        chunk.fileName,
        INSTRUMENTATION_PRELOAD_CHUNK_FILE_NAME,
      );
      const importLine = `import ${JSON.stringify(specifier)};`;

      // eve registers one plugin instance under both the Rolldown and the
      // Rollup Nitro config, so every hook here runs twice per build.
      // Without this guard the entry is rendered with the import already on
      // it and gets a second copy, offsetting the source map twice.
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
