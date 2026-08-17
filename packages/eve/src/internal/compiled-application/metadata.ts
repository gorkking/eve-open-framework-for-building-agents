import { z } from "#compiled/zod/index.js";

export const COMPILE_METADATA_KIND = "eve-compile-metadata";
export const COMPILE_METADATA_VERSION = 5;

interface CompileArtifactDigest {
  path: string;
  sha256: string;
}

export interface CompileMetadata {
  compile: {
    moduleMap: CompileArtifactDigest;
  };
  discovery: {
    diagnostics: CompileArtifactDigest;
    manifest: CompileArtifactDigest;
    sourceGraphHash: string;
    summary: {
      errors: number;
      warnings: number;
    };
  };
  generator: {
    name: string;
    version: string;
  };
  kind: typeof COMPILE_METADATA_KIND;
  status: "failed" | "ready";
  version: typeof COMPILE_METADATA_VERSION;
}

const compileArtifactDigestSchema = z
  .object({
    path: z.string(),
    sha256: z.string(),
  })
  .strict();

export const compileMetadataSchema: z.ZodType<CompileMetadata> = z
  .object({
    compile: z.object({ moduleMap: compileArtifactDigestSchema }).strict(),
    discovery: z
      .object({
        diagnostics: compileArtifactDigestSchema,
        manifest: compileArtifactDigestSchema,
        sourceGraphHash: z.string(),
        summary: z.object({ errors: z.number().finite(), warnings: z.number().finite() }).strict(),
      })
      .strict(),
    generator: z.object({ name: z.string(), version: z.string() }).strict(),
    kind: z.literal(COMPILE_METADATA_KIND),
    status: z.union([z.literal("failed"), z.literal("ready")]),
    version: z.literal(COMPILE_METADATA_VERSION),
  })
  .strict();
