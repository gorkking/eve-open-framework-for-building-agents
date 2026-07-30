import { z } from "#compiled/zod/index.js";

const SOURCE_DIFF_APPROVAL_PREFIX = "eve:source-diff-approval:";

const sourceDiffPresentationSchema = z
  .object({
    changedBytes: z.number().int().nonnegative(),
    files: z.array(
      z
        .object({
          after: z.string().nullable(),
          before: z.string().nullable(),
          path: z.string(),
          status: z.enum(["create", "delete", "modify"]),
        })
        .strict(),
    ),
    kind: z.literal("source-diff"),
  })
  .strict();

/** Trusted, host-computed source content presented by local approval clients. */
export type SourceDiffPresentation = z.infer<typeof sourceDiffPresentationSchema>;

/** Encodes structured approval detail through the existing durable prompt field. */
export function encodeSourceDiffApproval(presentation: SourceDiffPresentation): string {
  return `${SOURCE_DIFF_APPROVAL_PREFIX}${JSON.stringify(presentation)}`;
}

/** Decodes source-diff approval detail, returning undefined for ordinary prompts. */
export function decodeSourceDiffApproval(prompt: string): SourceDiffPresentation | undefined {
  if (!prompt.startsWith(SOURCE_DIFF_APPROVAL_PREFIX)) return undefined;
  try {
    const parsed = sourceDiffPresentationSchema.safeParse(
      JSON.parse(prompt.slice(SOURCE_DIFF_APPROVAL_PREFIX.length)),
    );
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
