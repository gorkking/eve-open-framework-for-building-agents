/**
 * Model role used when materializing authored instructions.
 */
export type InstructionsRole = "system" | "user";

/**
 * Public definition for instructions authored in markdown or TypeScript.
 *
 * Authored at the agent root as either `instructions.md` or
 * `instructions.{ts,cts,mts,js,cjs,mjs}`, or inside the
 * `agent/instructions/` directory for multi-file setups. Module-backed
 * static instructions execute once at build time. The compiler captures
 * the resulting content into the compiled manifest.
 *
 * `role` defaults to `"system"`. The legacy `markdown` shape remains
 * accepted during the deprecation window and always produces system-role
 * instructions.
 */
export type PublicInstructionsDefinition =
  | {
      readonly content: string;
      readonly role?: InstructionsRole;
      readonly markdown?: never;
    }
  | {
      /** @deprecated Use `content` instead. */
      readonly markdown: string;
      readonly content?: never;
      readonly role?: never;
    };

/**
 * Internal definition for an instructions prompt authored in markdown or
 * TypeScript.
 */
export interface InternalInstructionsDefinition {
  readonly content: string;
  readonly name: string;
  readonly role: InstructionsRole;
}
