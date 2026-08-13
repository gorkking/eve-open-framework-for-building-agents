type RolldownOutputChunk = {
  readonly type: "chunk";
  readonly code: string;
  readonly fileName: string;
};

type RolldownOutputAsset = {
  readonly type: "asset";
  readonly fileName: string;
  readonly source: string | Uint8Array;
};

type RolldownOutput = {
  readonly output: readonly [RolldownOutputChunk, ...(RolldownOutputChunk | RolldownOutputAsset)[]];
};

type RolldownBuild = (options: Record<string, unknown>) => Promise<RolldownOutput>;
type RolldownParseAst = (
  sourceText: string,
  options?: Record<string, unknown> | null,
  filename?: string,
) => unknown;
export type RolldownParserLanguage = "js" | "jsx" | "ts" | "tsx";

type RolldownModule = {
  readonly build: RolldownBuild;
};

type RolldownParseAstModule = {
  readonly parseAst: RolldownParseAst;
};

let rolldownPromise: Promise<RolldownModule> | undefined;
let rolldownParseAstPromise: Promise<RolldownParseAstModule> | undefined;

/**
 * Lazily loads eve's direct Rolldown dependency so importing parser-backed
 * helpers does not eagerly initialize the native bundler.
 */
function loadRolldown(): Promise<RolldownModule> {
  rolldownPromise ??= import("rolldown") as Promise<RolldownModule>;

  return rolldownPromise;
}

/** Lazily loads Rolldown's parser for source transforms. */
export function loadRolldownParseAst(): Promise<RolldownParseAstModule> {
  rolldownParseAstPromise ??= import("rolldown/parseAst") as Promise<RolldownParseAstModule>;

  return rolldownParseAstPromise;
}

export function inferRolldownParserLanguage(filename: string): RolldownParserLanguage {
  if (filename.endsWith(".tsx")) return "tsx";
  if (filename.endsWith(".jsx")) return "jsx";
  if (/\.[cm]?ts$/.test(filename)) return "ts";
  return "js";
}

export async function parseWithRolldownAst(filename: string, sourceText: string): Promise<unknown> {
  const { parseAst } = await loadRolldownParseAst();
  return parseAst(
    sourceText,
    {
      astType: "ts",
      lang: inferRolldownParserLanguage(filename),
      range: true,
      sourceType: "module",
    },
    filename,
  );
}

/**
 * Runs a raw Rolldown build. Prefer {@link buildSingleRolldownChunk} for any
 * bundle whose consumer expects one in-memory file; use this directly only
 * for multi-file, written-to-disk output.
 */
export async function buildWithRolldown(options: Record<string, unknown>): Promise<RolldownOutput> {
  assertCustomRolldownConditionNames(options);
  const { build } = await loadRolldown();
  return await build(options);
}

const ROLLDOWN_STANDARD_CONDITION_NAMES = new Set([
  "browser",
  "default",
  "import",
  "node",
  "require",
]);

function assertCustomRolldownConditionNames(options: Record<string, unknown>): void {
  const resolve = options.resolve;
  if (resolve === null || typeof resolve !== "object") return;
  const conditionNames = Reflect.get(resolve, "conditionNames");
  if (!Array.isArray(conditionNames)) return;

  for (const conditionName of conditionNames) {
    if (typeof conditionName === "string" && ROLLDOWN_STANDARD_CONDITION_NAMES.has(conditionName)) {
      throw new Error(
        `Rolldown resolves the standard condition ${JSON.stringify(conditionName)} per import edge; conditionNames may contain only eve-specific additions.`,
      );
    }
  }
}

/**
 * Runs a Rolldown build whose contract is exactly one in-memory chunk:
 * code splitting is disabled and the result is asserted to contain a
 * single JavaScript chunk, so dynamic imports are inlined rather than
 * split into lazy chunks. Every eve single-file bundle (the authored-module
 * evaluator, immutable development generations, and workflow step/function
 * bundles) goes through this helper so the single-file policy and its
 * assertion cannot drift apart. The final Nitro application server build
 * does not use it and keeps code splitting enabled.
 */
export async function buildSingleRolldownChunk(
  description: string,
  options: Record<string, unknown> & { readonly output?: Record<string, unknown> },
): Promise<RolldownOutputChunk> {
  const result = await buildWithRolldown({
    ...options,
    write: false,
    output: { ...options.output, codeSplitting: false },
  });
  return getSingleRolldownChunk(result, description);
}

function getSingleRolldownChunk(output: RolldownOutput, description: string): RolldownOutputChunk {
  const chunks = output.output.filter((item) => item.type === "chunk");
  const chunk = chunks[0];

  if (chunk === undefined || chunks.length !== 1) {
    throw new Error(`Expected one bundled ${description}.`);
  }

  return chunk;
}
