import type { ModelMessage } from "ai";

import type {
  DynamicCapabilityResolveContext,
  DynamicResolveContext,
} from "#shared/dynamic-tool-definition.js";
import type { AlsContext } from "#context/container.js";
import {
  AuthKey,
  ChannelInstrumentationKey,
  SessionIdKey,
  InitiatorAuthKey,
  ContinuationTokenKey,
  SessionKey,
} from "#context/keys.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import { getAdapterKind } from "#channel/adapter.js";
import { buildCallbackContext } from "#context/build-callback-context.js";

type ReadableContext = Pick<AlsContext, "get">;

/**
 * Builds the {@link DynamicResolveContext} from the active ALS context.
 *
 * Shared by all three dynamic lifecycle dispatchers (tools, skills,
 * instructions) so resolver handlers receive a consistent context shape.
 */
export function buildResolveContext(
  ctx: ReadableContext,
  messages: readonly ModelMessage[],
): DynamicResolveContext {
  const channelAdapter = ctx.get(ChannelKey);
  return {
    session: {
      id: ctx.get(SessionIdKey) ?? "",
      auth: {
        current: ctx.get(AuthKey) ?? null,
        initiator: ctx.get(InitiatorAuthKey) ?? null,
      },
    },
    channel: {
      kind: channelAdapter !== undefined ? getAdapterKind(channelAdapter) : undefined,
      continuationToken: ctx.get(ContinuationTokenKey),
      metadata: ctx.get(ChannelInstrumentationKey)?.metadata,
    },
    messages,
  };
}

/** Builds the shared context for non-model dynamic capabilities. */
export function buildDynamicCapabilityResolveContext(
  ctx: ReadableContext,
  messages: readonly ModelMessage[],
  abortSignal: AbortSignal = AbortSignal.any([]),
): DynamicCapabilityResolveContext {
  const sessionId = ctx.get(SessionIdKey) ?? "";
  const currentAuth = ctx.get(AuthKey) ?? null;
  const initiatorAuth = ctx.get(InitiatorAuthKey) ?? null;
  const channelAdapter = ctx.get(ChannelKey);
  const continuationToken = ctx.get(ContinuationTokenKey);
  const channelInstrumentation = ctx.get(ChannelInstrumentationKey);
  const bundle = ctx.get(BundleKey);
  const session = ctx.get(SessionKey);
  let callbackContext: ReturnType<typeof buildCallbackContext> | undefined;
  try {
    callbackContext = buildCallbackContext();
  } catch {
    callbackContext = undefined;
  }

  return {
    abortSignal,
    agent: {
      name: bundle?.turnAgent?.id ?? "",
      nodeId: bundle?.nodeId,
    },
    session:
      callbackContext?.session ??
      ({
        id: sessionId,
        auth: {
          current: currentAuth,
          initiator: initiatorAuth,
        },
        parent: session?.parent,
        turn: session?.turn ?? { id: "", sequence: 0 },
      } satisfies DynamicCapabilityResolveContext["session"]),
    channel: {
      kind: channelAdapter !== undefined ? getAdapterKind(channelAdapter) : undefined,
      continuationToken,
      metadata: channelInstrumentation?.metadata,
    },
    getSandbox:
      callbackContext?.getSandbox ?? (() => Promise.reject(new Error("Sandbox unavailable."))),
    getSkill:
      callbackContext?.getSkill ??
      (() => {
        throw new Error("Skills unavailable.");
      }),
    messages,
  };
}
