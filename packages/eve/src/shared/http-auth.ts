/**
 * Escapes an HTTP authentication parameter for use inside a quoted string.
 *
 * Auth challenges use quoted-pair escaping for `"` and `\`.
 */
export function escapeAuthChallengeParameter(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}
