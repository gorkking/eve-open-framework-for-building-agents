import {
  createPrependedLineSourceMap,
  type PrependedLineSourceMap,
} from "#internal/bundler/prepended-line-source-map.js";

/**
 * Options for {@link buildNodeEsmCompatBanner} and
 * {@link createNodeEsmCompatBannerPlugin}.
 *
 * Bundle output that re-declares one of the CJS path globals at the top
 * level would otherwise collide with the banner, producing
 * `SyntaxError: Identifier '__dirname' has already been declared` at load
 * time. The banner builder omits any line whose binding the chunk already
 * provides.
 */
interface NodeEsmCompatBannerOptions {
  /** Whether to expose a CommonJS `require` shim alongside the path globals. */
  readonly includeRequire?: boolean;
}

interface BannerLine {
  readonly importLine: string;
  readonly declarationLine: string;
  readonly bindingPattern: RegExp;
}

// Match `const|let|var <name>` at the literal start of a line. Bundler
// output places module-scope declarations at column zero; indented
// declarations live inside functions, classes, or blocks and therefore do
// not collide with the banner.
const BANNER_LINES: readonly BannerLine[] = [
  {
    importLine: 'import { fileURLToPath as __eveFileURLToPath } from "node:url";',
    declarationLine: "const __filename = __eveFileURLToPath(import.meta.url);",
    bindingPattern: /^(?:const|let|var)\s+__filename(?![\w$])/m,
  },
  {
    importLine: 'import { dirname as __eveDirname } from "node:path";',
    declarationLine: "const __dirname = __eveDirname(__filename);",
    bindingPattern: /^(?:const|let|var)\s+__dirname(?![\w$])/m,
  },
];

const REQUIRE_LINE: BannerLine = {
  importLine: 'import { createRequire as __eveCreateRequire } from "node:module";',
  declarationLine: "const require = __eveCreateRequire(import.meta.url);",
  bindingPattern: /^(?:const|let|var)\s+require(?![\w$])/m,
};

/**
 * Builds the ESM CommonJS-compatibility banner appropriate for a single
 * bundle chunk's code. Identifiers the chunk already binds at the top
 * level (e.g. `const __dirname = ...` emitted by an inlined module) are
 * skipped so the prepended banner never re-declares them.
 *
 * Returns an empty string when the chunk already provides every binding.
 */
export function buildNodeEsmCompatBanner(
  code: string,
  options: NodeEsmCompatBannerOptions = {},
): string {
  const lines: BannerLine[] = [...BANNER_LINES];

  if (options.includeRequire === true) {
    lines.push(REQUIRE_LINE);
  }

  const imports: string[] = [];
  const declarations: string[] = [];

  for (const line of lines) {
    if (line.bindingPattern.test(code)) {
      continue;
    }

    imports.push(line.importLine);
    declarations.push(line.declarationLine);
  }

  if (declarations.length === 0) {
    return "";
  }

  return [...imports, ...declarations].join("\n");
}

interface BannerPlugin {
  readonly name: string;
  renderChunk(
    code: string,
    chunk?: { readonly fileName?: string },
  ): { code: string; map: PrependedLineSourceMap } | null;
}

/**
 * Creates a bundler plugin that prepends the Node ESM compatibility
 * banner to each output chunk, skipping any banner line whose binding
 * the chunk already provides. Compatible with both Rollup and Rolldown.
 */
export function createNodeEsmCompatBannerPlugin(
  options: NodeEsmCompatBannerOptions = {},
): BannerPlugin {
  return {
    name: "eve-node-esm-compat-banner",
    renderChunk(code, chunk) {
      const banner = buildNodeEsmCompatBanner(code, options);

      if (banner === "") {
        return null;
      }

      return {
        code: `${banner}\n${code}`,
        map: createPrependedLineSourceMap({
          insertedLineCount: banner.split("\n").length,
          source: chunk?.fileName ?? "eve-node-esm-compat-banner-input",
          sourceContent: code,
        }),
      };
    },
  };
}
