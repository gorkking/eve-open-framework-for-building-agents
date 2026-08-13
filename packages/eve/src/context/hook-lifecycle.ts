import { getAdapterKind } from "#channel/adapter.js";
import type { MessageStreamEvent } from "#protocol/message.js";
import type { HookContext } from "#public/definitions/hook.js";
import type { RuntimeHookRegistry } from "#runtime/hooks/registry.js";
import { buildCallbackContext } from "#context/build-callback-context.js";
import type { ContextContainer } from "./container.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { ChannelInstrumentationKey, ContinuationTokenKey } from "./keys.js";

/**
 * Fans one runtime stream event out to every matching subscriber.
 * Errors propagate — harness error paths convert them into the
 * recoverable `turn.failed` cascade. Caller must hold an active ALS
 * scope so hooks see the same context as the rest of the step.
 */
export async function dispatchStreamEventHooks(input: {
  readonly abortSignal: AbortSignal;
  readonly ctx: ContextContainer;
  readonly registry: RuntimeHookRegistry;
  readonly event: MessageStreamEvent;
  readonly messages: readonly import("ai").ModelMessage[];
}): Promise<void> {
  const typed = input.registry.streamEventsByType.get(input.event.type) ?? [];
  const wildcard = input.registry.streamEventsWildcard;

  if (typed.length === 0 && wildcard.length === 0) {
    return;
  }

  const hookCtx = buildHookContext(input.ctx, input.abortSignal, input.messages);
  for (const entry of typed) {
    await entry.handler(input.event, hookCtx);
  }
  for (const entry of wildcard) {
    await entry.handler(input.event, hookCtx);
  }
}

/** Builds the {@link HookContext} surfaced to one handler. */
function buildHookContext(
  ctx: ContextContainer,
  abortSignal: AbortSignal,
  messages: HookContext["messages"],
): HookContext {
  const bundle = ctx.require(BundleKey);
  const channelAdapter = ctx.get(ChannelKey);
  const continuationToken = ctx.get(ContinuationTokenKey);
  const channelInstrumentation = ctx.get(ChannelInstrumentationKey);
  const kind = channelAdapter !== undefined ? getAdapterKind(channelAdapter) : undefined;
  const callbackCtx = buildCallbackContext();

  return {
    ...callbackCtx,
    abortSignal,
    agent: {
      name: bundle.turnAgent.id,
      nodeId: bundle.nodeId,
    },
    channel: {
      kind,
      continuationToken,
      metadata: channelInstrumentation?.metadata,
    },
    messages,
  };
}
