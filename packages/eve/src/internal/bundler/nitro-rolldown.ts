import type { RolldownOutput, RolldownOutputChunk } from "@eve/build";

import { loadBuildEngine } from "#internal/build-engine.js";

export type RolldownParserLanguage = "js" | "jsx" | "ts" | "tsx";

export function inferRolldownParserLanguage(filename: string): RolldownParserLanguage {
  if (filename.endsWith(".tsx")) return "tsx";
  if (filename.endsWith(".jsx")) return "jsx";
  if (/\.[cm]?ts$/.test(filename)) return "ts";
  return "js";
}

export async function parseWithNitroRolldownAst(
  filename: string,
  sourceText: string,
): Promise<unknown> {
  const { parseWithRolldown } = await loadBuildEngine();
  return await parseWithRolldown(
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
export async function buildWithNitroRolldown(
  options: Record<string, unknown>,
): Promise<RolldownOutput> {
  const { buildWithRolldown } = await loadBuildEngine();
  return await buildWithRolldown(options);
}

/**
 * Runs a Rolldown build whose contract is exactly one in-memory chunk:
 * code splitting is disabled and the result is asserted to contain a
 * single JavaScript chunk, so dynamic imports are inlined rather than
 * split into lazy chunks. Every eve single-file bundle (the authored-module
 * evaluator, immutable development generations, and workflow step/function
 * bundles) goes through this helper so the single-file policy and its
 * assertion cannot drift apart. The final Nitro production server build
 * does not use it and keeps code splitting enabled.
 */
export async function buildSingleRolldownChunk(
  description: string,
  options: Record<string, unknown> & { readonly output?: Record<string, unknown> },
): Promise<RolldownOutputChunk> {
  const result = await buildWithNitroRolldown({
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
