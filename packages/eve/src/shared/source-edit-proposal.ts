/** Exact text transition stored compactly as `[path, before, after]`. */
export type SourceEditChange = readonly [path: string, before: string | null, after: string | null];

/** Trusted source changes finalized for approval and application. */
export interface SourceEditProposal {
  readonly changes: readonly SourceEditChange[];
  readonly id: string;
  readonly summary: string;
}
