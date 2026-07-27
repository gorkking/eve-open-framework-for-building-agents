/**
 * Source map shared by the bundler plugins that prepend lines to a chunk.
 */
export interface PrependedLineSourceMap {
  readonly version: 3;
  readonly sources: readonly string[];
  readonly sourcesContent: readonly string[];
  readonly names: readonly string[];
  readonly mappings: string;
}

/**
 * Builds the source map for a chunk that had `insertedLineCount` lines
 * prepended to it, so positions in the emitted chunk still resolve to the
 * original line.
 */
export function createPrependedLineSourceMap({
  insertedLineCount,
  source,
  sourceContent,
}: {
  insertedLineCount: number;
  source: string;
  sourceContent: string;
}): PrependedLineSourceMap {
  const originalLineCount = sourceContent.split("\n").length;
  const lineMappings = Array.from({ length: originalLineCount }, (_, index) =>
    encodeVlqFields(index === 0 ? [0, 0, 0, 0] : [0, 0, 1, 0]),
  );

  return {
    version: 3,
    sources: [source],
    sourcesContent: [sourceContent],
    names: [],
    mappings: `${";".repeat(insertedLineCount)}${lineMappings.join(";")}`,
  };
}

const BASE64_VLQ_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const VLQ_BASE_SHIFT = 5;
const VLQ_BASE = 1 << VLQ_BASE_SHIFT;
const VLQ_BASE_MASK = VLQ_BASE - 1;
const VLQ_CONTINUATION_BIT = VLQ_BASE;

function encodeVlqFields(fields: readonly number[]): string {
  return fields.map((field) => encodeVlqInteger(field)).join("");
}

function encodeVlqInteger(value: number): string {
  let vlq = value < 0 ? (-value << 1) + 1 : value << 1;
  let encoded = "";

  do {
    let digit = vlq & VLQ_BASE_MASK;
    vlq >>>= VLQ_BASE_SHIFT;

    if (vlq > 0) {
      digit |= VLQ_CONTINUATION_BIT;
    }

    encoded += BASE64_VLQ_CHARS[digit];
  } while (vlq > 0);

  return encoded;
}
