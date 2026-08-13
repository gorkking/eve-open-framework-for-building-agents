/**
 * Skill authoring helpers and runtime accessors.
 */

export type { SkillFile, SkillHandle } from "#execution/skills/types.js";
export {
  defineSkill,
  type NamedSkillDefinition,
  type SkillDefinition,
  type SkillFileContent,
  type SkillPackageDefinition,
} from "#public/definitions/skill.js";
import type { SkillDefinition } from "#public/definitions/skill.js";
import { defineDynamic as defineDynamicBase } from "#public/definitions/tool.js";
import type {
  DynamicEvents,
  DynamicSentinel,
  DynamicToolEventName,
} from "#shared/dynamic-tool-definition.js";

type SkillDynamicResult = SkillDefinition | Readonly<Record<string, SkillDefinition>> | null;
type SkillDynamicEventName = Exclude<DynamicToolEventName, "step.started">;
type SkillDynamicEvents = DynamicEvents<SkillDynamicResult, SkillDynamicEventName>;

/** Defines skills resolved at session and turn boundaries. */
export function defineDynamic<const TEvents extends SkillDynamicEvents>(definition: {
  readonly events: TEvents;
}): DynamicSentinel<SkillDynamicResult, SkillDynamicEventName> {
  return defineDynamicBase({ events: definition.events as never }) as DynamicSentinel<
    SkillDynamicResult,
    SkillDynamicEventName
  >;
}
export type {
  DynamicCapabilityResolveContext as DynamicResolveContext,
  DynamicSentinel,
} from "#shared/dynamic-tool-definition.js";
