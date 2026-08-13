import type { ModelMessage, SystemModelMessage } from "ai";

import {
  ALLOWED_DYNAMIC_INSTRUCTION_EVENTS,
  isBrandedInstructionsEntry,
} from "#shared/dynamic-tool-definition.js";
import type { InstructionsDefinition } from "#public/definitions/instructions.js";
import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type { ResolvedDynamicInstructionsResolver } from "#runtime/types.js";
import { createLogger } from "#internal/logging.js";
import { toErrorMessage } from "#shared/errors.js";
import type { ContextContainer } from "#context/container.js";
import type { ContextKey } from "#context/key.js";
import {
  LiveStepDynamicInstructionsKey,
  PendingDynamicInstructionMessagesKey,
  SessionDynamicInstructionsKey,
  TurnDynamicInstructionsKey,
} from "#context/keys.js";
import { buildDynamicCapabilityResolveContext } from "#context/dynamic-resolve-context.js";

const log = createLogger("dynamic-instructions");

type SlugMessageMap = Record<string, readonly SystemModelMessage[]>;
type StepSlugMessageMap = Record<string, readonly SystemModelMessage[] | null>;

function normalizeDefinition(definition: InstructionsDefinition): {
  readonly content: string;
  readonly role: "system" | "user";
} {
  return "markdown" in definition
    ? { content: definition.markdown!, role: "system" }
    : { content: definition.content, role: definition.role ?? "system" };
}

function durableKeyForEvent(eventType: string): ContextKey<SlugMessageMap> | undefined {
  switch (eventType) {
    case "session.started":
      return SessionDynamicInstructionsKey;
    case "turn.started":
      return TurnDynamicInstructionsKey;
    default:
      return undefined;
  }
}

/** Builds effective system instructions with step > turn > session precedence per slug. */
export function buildDynamicInstructionMessages(ctx: {
  get<T>(key: ContextKey<T>): T | undefined;
}): SystemModelMessage[] {
  const session = ctx.get(SessionDynamicInstructionsKey) ?? {};
  const turn = ctx.get(TurnDynamicInstructionsKey) ?? {};
  const step = ctx.get(LiveStepDynamicInstructionsKey) ?? {};
  const slugs = new Set([...Object.keys(session), ...Object.keys(turn), ...Object.keys(step)]);
  const messages: SystemModelMessage[] = [];

  for (const slug of slugs) {
    if (Object.hasOwn(step, slug)) {
      messages.push(...(step[slug] ?? []));
    } else if (Object.hasOwn(turn, slug)) {
      messages.push(...(turn[slug] ?? []));
    } else {
      messages.push(...(session[slug] ?? []));
    }
  }

  return messages;
}

/** Takes user-role instructions produced since the previous history boundary. */
export function takePendingDynamicInstructionMessages(ctx: ContextContainer): ModelMessage[] {
  const messages = [...(ctx.get(PendingDynamicInstructionMessagesKey) ?? [])];
  ctx.setVirtualContext(PendingDynamicInstructionMessagesKey, []);
  return messages;
}

/** Dispatches one lifecycle event to matching dynamic instruction resolvers. */
export async function dispatchDynamicInstructionEvent(input: {
  readonly abortSignal?: AbortSignal;
  readonly ctx: ContextContainer;
  readonly resolvers: readonly ResolvedDynamicInstructionsResolver[];
  readonly event: UnstampedMessageStreamEvent;
  readonly messages: readonly ModelMessage[];
}): Promise<void> {
  const { ctx, resolvers, event, messages } = input;

  if (!ALLOWED_DYNAMIC_INSTRUCTION_EVENTS.has(event.type)) return;

  const matching = resolvers.filter((resolver) => resolver.eventNames.includes(event.type));
  if (matching.length === 0) return;

  const resolveCtx = buildDynamicCapabilityResolveContext(ctx, messages, input.abortSignal);
  const outcomes = await Promise.allSettled(
    matching.map(async (resolver) => {
      const handler = resolver.events[event.type];
      if (handler === undefined) return null;

      const rawResult = await handler(event, resolveCtx);
      if (rawResult === null || rawResult === undefined) return { resolver, result: null };

      if (!isBrandedInstructionsEntry(rawResult)) {
        log.error(
          `Dynamic instructions resolver "${resolver.slug}" returned an unbranded value — wrap with defineInstructions().`,
        );
        return null;
      }

      return { resolver, result: normalizeDefinition(rawResult as InstructionsDefinition) };
    }),
  );

  const durableKey = durableKeyForEvent(event.type);
  const system: SlugMessageMap | StepSlugMessageMap =
    event.type === "step.started"
      ? { ...ctx.get(LiveStepDynamicInstructionsKey) }
      : durableKey === undefined
        ? {}
        : { ...ctx.get(durableKey) };
  const pending = [...(ctx.get(PendingDynamicInstructionMessagesKey) ?? [])];

  for (const resolver of matching) delete system[resolver.slug];

  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      log.error(`Dynamic instructions resolver (${event.type}) threw — skipping.`, {
        error: toErrorMessage(outcome.reason),
      });
      continue;
    }
    if (outcome.value === null) continue;

    const { resolver, result } = outcome.value;
    if (result === null || result.content.trim().length === 0) {
      if (event.type === "step.started") system[resolver.slug] = null;
      continue;
    }

    if (result.role === "system") {
      system[resolver.slug] = [{ role: "system", content: result.content.trim() }];
    } else {
      pending.push({ role: "user", content: result.content.trim() });
      system[resolver.slug] = event.type === "step.started" ? null : [];
    }
  }

  if (event.type === "step.started") {
    ctx.setVirtualContext(LiveStepDynamicInstructionsKey, system as StepSlugMessageMap);
  } else if (durableKey !== undefined) {
    ctx.set(durableKey, system as SlugMessageMap);
  }
  ctx.setVirtualContext(PendingDynamicInstructionMessagesKey, pending);
}
