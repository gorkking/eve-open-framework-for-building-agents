/**
 * Instructions prompt authoring helpers for `agent/instructions.ts`
 * and `agent/instructions/*.ts` files.
 */

export {
  defineInstructions,
  type InstructionsDefinition,
} from "#public/definitions/instructions.js";

import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import { defineDynamic as defineDynamicBase } from "#public/definitions/tool.js";
import type { DynamicEvents, DynamicSentinel } from "#shared/dynamic-tool-definition.js";

type InstructionsDynamicResult = InstructionsDefinition | null;
type InstructionsDynamicEventName = "session.started" | "turn.started" | "step.started";
type InstructionsDynamicEvents = DynamicEvents<
  InstructionsDynamicResult,
  InstructionsDynamicEventName
>;

/** Defines role-aware instructions resolved at supported lifecycle boundaries. */
export function defineDynamic<const TEvents extends InstructionsDynamicEvents>(definition: {
  readonly events: TEvents;
}): DynamicSentinel<InstructionsDynamicResult, InstructionsDynamicEventName> {
  return defineDynamicBase({ events: definition.events }) as DynamicSentinel<
    InstructionsDynamicResult,
    InstructionsDynamicEventName
  >;
}

export type {
  DynamicCapabilityResolveContext as DynamicResolveContext,
  DynamicSentinel,
} from "#shared/dynamic-tool-definition.js";
