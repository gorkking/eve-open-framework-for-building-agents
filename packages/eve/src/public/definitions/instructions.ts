import { INSTRUCTIONS_BRAND } from "#shared/dynamic-tool-definition.js";
import type { ExactDefinition } from "#public/definitions/exact.js";
import type { PublicInstructionsDefinition } from "#shared/instructions-definition.js";

export type InstructionsDefinition = Readonly<PublicInstructionsDefinition>;

/**
 * Defines role-aware instructions in TypeScript.
 *
 * Use it to return instructions from a `defineDynamic` resolver in
 * `agent/instructions/`; the returned content lowers to one model message
 * with the selected role. For a fixed prompt with no resolver,
 * author `instructions.md` instead. The result is branded so the dynamic
 * instruction lifecycle can validate that a resolver return came through
 * this helper. `role` defaults to `"system"`; use `"user"` for durable,
 * append-only model context.
 */
export function defineInstructions<TInstructions extends InstructionsDefinition>(
  definition: ExactDefinition<TInstructions, InstructionsDefinition>,
): TInstructions {
  Object.assign(definition, { [INSTRUCTIONS_BRAND]: true });
  return definition;
}
