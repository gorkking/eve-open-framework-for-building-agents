import { describe, expect, it } from "vitest";

import {
  createInstrumentationPreloadPlugin,
  INSTRUMENTATION_PRELOAD_CHUNK_FILE_NAME,
} from "#internal/bundler/instrumentation-preload-plugin.js";

const INSTRUMENTATION_MODULE_PATH = "/app/.eve/host/compiled-artifacts-instrumentation.mjs";

interface EmittedChunk {
  readonly type: "chunk";
  readonly id: string;
  readonly fileName: string;
}

/**
 * Minimal stand-in for the Rollup/Rolldown plugin context, recording the
 * emitted chunk so assertions can read it back the way the bundler would.
 */
function createBundlerContext() {
  const emitted: EmittedChunk[] = [];

  return {
    emitted,
    emitFile(file: EmittedChunk): string {
      emitted.push(file);
      return `ref-${emitted.length}`;
    },
    getFileName(referenceId: string): string {
      const index = Number(referenceId.replace("ref-", "")) - 1;
      const file = emitted[index];
      if (file === undefined) {
        throw new Error(`Unknown reference id ${referenceId}`);
      }
      return file.fileName;
    },
  };
}

function renderEntry(input: {
  readonly code?: string;
  readonly fileName: string;
  readonly isEntry?: boolean;
}) {
  const plugin = createInstrumentationPreloadPlugin(INSTRUMENTATION_MODULE_PATH);
  const context = createBundlerContext();
  plugin.buildStart.call(context);

  return {
    context,
    result: plugin.renderChunk.call(context, input.code ?? "console.log('entry');", {
      fileName: input.fileName,
      isEntry: input.isEntry ?? true,
    }),
  };
}

describe("createInstrumentationPreloadPlugin", () => {
  it("emits the instrumentation module as its own chunk", () => {
    const plugin = createInstrumentationPreloadPlugin(INSTRUMENTATION_MODULE_PATH);
    const context = createBundlerContext();

    plugin.buildStart.call(context);

    expect(context.emitted).toEqual([
      {
        type: "chunk",
        id: INSTRUMENTATION_MODULE_PATH,
        fileName: INSTRUMENTATION_PRELOAD_CHUNK_FILE_NAME,
      },
    ]);
  });

  it("imports the preload on the entry's first line, ahead of hoisted imports", () => {
    const { result } = renderEntry({
      code: 'import { Pool } from "pg";\nconsole.log(Pool);',
      fileName: "index.mjs",
    });

    expect(result?.code.split("\n")[0]).toBe(
      `import "./${INSTRUMENTATION_PRELOAD_CHUNK_FILE_NAME}";`,
    );
    expect(result?.code).toContain('import { Pool } from "pg";');
  });

  it("maps the shifted chunk back to its original line", () => {
    const { result } = renderEntry({ fileName: "index.mjs" });

    expect(result?.map.mappings.startsWith(";")).toBe(true);
    expect(result?.map.sources).toEqual(["index.mjs"]);
  });

  it("resolves the preload relative to a nested entry chunk", () => {
    const { result } = renderEntry({ fileName: "functions/__server.func/index.mjs" });

    expect(result?.code.split("\n")[0]).toBe(
      `import "../../${INSTRUMENTATION_PRELOAD_CHUNK_FILE_NAME}";`,
    );
  });

  it("does not prepend the import twice when rendered again", () => {
    const plugin = createInstrumentationPreloadPlugin(INSTRUMENTATION_MODULE_PATH);
    const context = createBundlerContext();
    plugin.buildStart.call(context);
    const chunk = { fileName: "index.mjs", isEntry: true };

    const first = plugin.renderChunk.call(context, "console.log('entry');", chunk);
    const second = plugin.renderChunk.call(context, first?.code ?? "", chunk);

    expect(second).toBeNull();
  });

  it("leaves shared chunks alone", () => {
    const { result } = renderEntry({ fileName: "_libs/drizzle-orm.mjs", isEntry: false });

    expect(result).toBeNull();
  });

  it("does not make the preload chunk import itself", () => {
    const { result } = renderEntry({ fileName: INSTRUMENTATION_PRELOAD_CHUNK_FILE_NAME });

    expect(result).toBeNull();
  });
});
