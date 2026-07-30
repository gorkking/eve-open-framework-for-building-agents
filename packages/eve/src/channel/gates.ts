import type { ChannelAdapterContext } from "#channel/adapter.js";
import type { SendPayload } from "#channel/routes.js";
import type { SessionAuth, SessionParent, SessionTurn } from "#context/keys.js";
import type { InputRequest, InputResponse } from "#runtime/input/types.js";
import type { GenericReceiveInput } from "#shared/channel-definition.js";
import { ChannelGateDeniedError, ChannelGateUnavailableError } from "#channel/gate-errors.js";

/**
 * Explicit decision returned by every authored channel gate.
 */
export type ChannelGateDecision =
  | { readonly type: "allow" }
  | { readonly type: "deny"; readonly reason?: string };

/** Names of the session-bound gates supported by a channel adapter. */
export type SessionChannelGateName =
  | "input.response"
  | "session.resume"
  | "turn.cancel"
  | "session.reset";

/** Every gate name supported by {@link ChannelGates}. */
export type ChannelGateName = SessionChannelGateName | "channel.receive";

/**
 * Stable session metadata available while evaluating a session-bound gate.
 *
 * Gate callbacks intentionally do not receive sandbox or skill access: gates
 * are policy checks and their durable channel/session mutations are discarded.
 */
export interface ChannelGateContext {
  readonly session: {
    readonly id: string;
    readonly auth: SessionAuth;
    readonly turn: SessionTurn;
    readonly parent?: SessionParent;
  };
}

/** Channel-owned context exposed read-only to a session-bound gate. */
export type ChannelGateChannel<TContext> = Omit<
  Readonly<[TContext] extends [void] ? Record<never, never> : TContext>,
  "setContinuationToken"
> & {
  readonly continuationToken: string;
};

/** Normalized payload inspected by the `"session.resume"` gate. */
export type SessionResumeGateInput = Readonly<SendPayload>;

/** An explicit or text-derived answer to pending human input. */
export interface InputResponseAnswerGateInput {
  readonly type: "answer";
  readonly source: "explicit" | "text";
  readonly requests: readonly InputRequest[];
  readonly responses: readonly InputResponse[];
}

/** A follow-up message that dismisses pending dismissable questions. */
export interface InputResponseDismissGateInput {
  readonly type: "dismiss";
  readonly source: "message";
  readonly requests: readonly InputRequest[];
  readonly responses: readonly [];
}

/** Input inspected by the `"input.response"` gate. */
export type InputResponseGateInput = InputResponseAnswerGateInput | InputResponseDismissGateInput;

/** Input inspected by the `"turn.cancel"` gate. */
export interface TurnCancelGateInput {
  readonly turnId?: string;
}

/** Input inspected by the `"session.reset"` gate. */
export interface SessionResetGateInput {
  readonly reason?: string;
}

/** Origin of a proactive cross-channel receive. */
export type ChannelReceiveSource =
  | { readonly type: "channel"; readonly name: string }
  | { readonly type: "schedule"; readonly name: string };

/** Context passed to the pre-session `"channel.receive"` gate. */
export interface ChannelReceiveGateContext {
  readonly source: ChannelReceiveSource;
}

/** Input inspected by the `"channel.receive"` gate. */
export type ChannelReceiveGateInput<TReceiveTarget = Record<string, unknown>> =
  GenericReceiveInput<TReceiveTarget>;

type SessionGateHandler<TInput, TContext> = (
  input: Readonly<TInput>,
  channel: ChannelGateChannel<TContext>,
  ctx: ChannelGateContext,
) => ChannelGateDecision | Promise<ChannelGateDecision>;

/**
 * Policy gates accepted by {@link import("#public/definitions/channel.js").defineChannel}.
 *
 * Omitted gates allow the operation. Configured handlers must return an
 * explicit tagged decision.
 */
export interface ChannelGates<TContext = void, TReceiveTarget = Record<string, unknown>> {
  readonly "input.response"?: SessionGateHandler<InputResponseGateInput, TContext>;
  readonly "session.resume"?: SessionGateHandler<SessionResumeGateInput, TContext>;
  readonly "turn.cancel"?: SessionGateHandler<TurnCancelGateInput, TContext>;
  readonly "session.reset"?: SessionGateHandler<SessionResetGateInput, TContext>;
  readonly "channel.receive"?: (
    input: ChannelReceiveGateInput<TReceiveTarget>,
    ctx: ChannelReceiveGateContext,
  ) => ChannelGateDecision | Promise<ChannelGateDecision>;
}

/** Runtime-facing form of a session-bound gate handler. */
export type ChannelAdapterGateHandler<TInput = unknown> = (
  input: TInput,
  adapterCtx: ChannelAdapterContext,
  ctx: ChannelGateContext,
) => ChannelGateDecision | Promise<ChannelGateDecision>;

/** Runtime-facing session gate map stored on a channel adapter. */
export type ChannelAdapterGates = Partial<
  Record<SessionChannelGateName, ChannelAdapterGateHandler>
>;

/** Returns whether a value is a valid explicit channel-gate decision. */
export function isChannelGateDecision(value: unknown): value is ChannelGateDecision {
  try {
    if (typeof value !== "object" || value === null) return false;
    const keys = Object.keys(value);
    const decision = value as { readonly type?: unknown; readonly reason?: unknown };
    if (decision.type === "allow") {
      return keys.length === 1 && keys[0] === "type";
    }
    return (
      decision.type === "deny" &&
      keys.every((key) => key === "type" || key === "reason") &&
      (decision.reason === undefined || typeof decision.reason === "string")
    );
  } catch {
    return false;
  }
}

/** Returns the configured session-gate names on an adapter. */
export function getSessionChannelGateNames(
  gates: ChannelAdapterGates | undefined,
): readonly SessionChannelGateName[] {
  if (gates === undefined) return [];
  return (["session.resume", "input.response", "turn.cancel", "session.reset"] as const).filter(
    (name) => gates[name] !== undefined,
  );
}

/** Evaluates a pre-session receive gate and converts failures to typed errors. */
export async function evaluateChannelReceiveGate<TReceiveTarget>(input: {
  readonly gate: ChannelGates<any, TReceiveTarget>["channel.receive"];
  readonly payload: GenericReceiveInput<TReceiveTarget>;
  readonly source: ChannelReceiveSource;
}): Promise<void> {
  if (input.gate === undefined) return;

  let decision: unknown;
  try {
    decision = await input.gate(structuredClone(input.payload), {
      source: structuredClone(input.source),
    });
  } catch (error) {
    throw new ChannelGateUnavailableError("channel.receive", { cause: error });
  }

  if (!isChannelGateDecision(decision)) {
    throw new ChannelGateUnavailableError("channel.receive", {
      cause: new TypeError('The "channel.receive" gate returned an invalid decision.'),
    });
  }

  if (decision.type === "deny") {
    throw new ChannelGateDeniedError("channel.receive", decision.reason);
  }
}
