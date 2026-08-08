import { createLogger, formatError } from "#internal/logging.js";
import {
  instrumentationStateSlot,
  releaseInstrumentationAttemptState,
  releaseInstrumentationState,
  type InstrumentationStateSlot,
} from "#harness/instrumentation-state.js";

/**
 * Stable eve identity for one actual model attempt.
 *
 * A step retried three times produces three of these, all sharing `stepIndex`
 * and separated by `attemptIndex` — which is why the events carrying this
 * scope are named `step.attempt.*` and not `step.*`. The protocol's `step.*`
 * and the `events["step.started"]` resolver hook fire once per step; these
 * fire once per attempt.
 */
export interface InstrumentationAttemptScope {
  readonly attemptId: string;
  readonly attemptIndex: number;
  readonly functionId?: string;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly stepIndex: number;
  readonly turnId: string;
}

/** The model SDK operation an attempt runs through. */
export interface InstrumentationOperationRef {
  readonly modelId: string;
  readonly operationId: string;
  readonly provider: string;
}

export interface InstrumentationModelRef {
  readonly modelId: string;
  readonly provider: string;
}

/** Token usage for one model call. A field is absent when the provider omits it. */
export interface InstrumentationUsage {
  readonly inputTokenDetails?: {
    readonly cacheReadTokens?: number;
    readonly cacheWriteTokens?: number;
  };
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}

/** Final model input for one call. Message shape stays opaque to this layer. */
export interface InstrumentationModelInput {
  readonly instructions?: unknown;
  readonly messages: readonly unknown[];
}

/**
 * The model response parts eve records. A kind outside this union is dropped
 * when the bridge maps a response, so widening the union is what makes a new
 * kind reachable by a provider.
 */
export type InstrumentationContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | { readonly type: "tool-call"; readonly input: unknown; readonly toolName: string }
  | {
      readonly type: "tool-result";
      readonly input: unknown;
      readonly output: unknown;
      readonly toolName: string;
    }
  | {
      readonly type: "tool-error";
      readonly error: unknown;
      readonly input: unknown;
      readonly toolName: string;
    };

/**
 * What eve dispatched a tool call as. The model sees every action as a tool,
 * so this is the only thing that separates a subagent or remote-agent call
 * from an ordinary tool in a trace.
 */
export type InstrumentationActionKind = "remote-agent-call" | "subagent-call" | "tool-call";

/** How one tool execution ended. */
export type InstrumentationToolOutput =
  | { readonly type: "result"; readonly output: unknown }
  | { readonly type: "error"; readonly error: unknown };

/** Replay-stable row identity for every lifecycle operation. */
export function sessionIdempotencyKey(sessionId: string): string {
  return `session:${sessionId}`;
}

export function turnIdempotencyKey(sessionId: string, turnId: string): string {
  return `turn:${sessionId}:${turnId}`;
}

export function attemptIdempotencyKey(scope: InstrumentationAttemptScope): string {
  return `step:${scope.attemptId}`;
}

/** One model call occurs per AI SDK step within an eve attempt. */
export function modelCallIdempotencyKey(
  scope: InstrumentationAttemptScope,
  stepNumber: number,
): string {
  return `model:${scope.attemptId}:${String(stepNumber)}`;
}

export function toolCallIdempotencyKey(
  scope: InstrumentationAttemptScope,
  callId: string,
  stepNumber: number,
): string {
  return `tool:${scope.attemptId}:${callId}:${String(stepNumber)}`;
}

export interface InstrumentationStepAttemptStartedEvent {
  readonly type: "step.attempt.started";
  readonly idempotencyKey: string;
  readonly operation: InstrumentationOperationRef;
  readonly scope: InstrumentationAttemptScope;
}

export interface InstrumentationSessionStartedEvent {
  readonly type: "session.started";
  readonly agentName?: string;
  readonly channelKind?: string;
  readonly idempotencyKey: string;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sessionId: string;
}

export interface InstrumentationTraceContext {
  readonly spanId: string;
  readonly traceFlags: number;
  readonly traceId: string;
}

/**
 * Which tool call dispatched a subagent child. The trace structure alone
 * cannot say: one turn's children all parent to the same window.
 */
export interface InstrumentationParentLineage {
  readonly callId: string;
  readonly sessionId: string;
  readonly subagentName?: string;
  readonly turnId: string;
}

/**
 * A session transition that carries no failure.
 *
 * `session.waiting` sits here rather than with the failed shape because it is
 * not terminal: the session suspends awaiting input or approval and may resume
 * with a new turn.
 */
export interface InstrumentationSessionSettledEvent {
  readonly type: "session.completed" | "session.waiting";
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId?: string;
}

export interface InstrumentationSessionFailedEvent {
  readonly type: "session.failed";
  readonly error: unknown;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId?: string;
}

export type InstrumentationSessionTransitionEvent =
  | InstrumentationSessionSettledEvent
  | InstrumentationSessionFailedEvent;

export interface InstrumentationTurnStartedEvent {
  readonly type: "turn.started";
  readonly idempotencyKey: string;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface InstrumentationTurnSettledEvent {
  readonly type: "turn.cancelled" | "turn.completed";
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export interface InstrumentationTurnFailedEvent {
  readonly type: "turn.failed";
  readonly error: unknown;
  readonly idempotencyKey: string;
  readonly sessionId: string;
  readonly turnId: string;
}

export type InstrumentationTurnTerminalEvent =
  | InstrumentationTurnSettledEvent
  | InstrumentationTurnFailedEvent;

export interface InstrumentationStepAttemptCompletedEvent {
  readonly type: "step.attempt.completed";
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
}

export interface InstrumentationStepAttemptFailedEvent {
  readonly type: "step.attempt.failed";
  readonly error: unknown;
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
}

export type InstrumentationStepAttemptTerminalEvent =
  | InstrumentationStepAttemptCompletedEvent
  | InstrumentationStepAttemptFailedEvent;

/**
 * Provider metadata for one completed attempt, as reported by the AI SDK
 * (`StepResult.providerMetadata`). Carries Vercel AI Gateway cost data when
 * the request went through the gateway; absent for other providers.
 */
export interface InstrumentationStepAttemptMetadataEvent {
  readonly type: "step.attempt.metadata";
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
  readonly providerMetadata: Readonly<Record<string, unknown>>;
}

export interface InstrumentationModelCallStartedEvent {
  readonly type: "model.call.started";
  readonly idempotencyKey: string;
  readonly input: InstrumentationModelInput;
  readonly model: InstrumentationModelRef;
  readonly scope: InstrumentationAttemptScope;
}

export interface InstrumentationModelCallCompletedEvent {
  readonly type: "model.call.completed";
  readonly content: readonly InstrumentationContentPart[];
  readonly finishReason: string;
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
  readonly usage: InstrumentationUsage;
}

export interface InstrumentationModelCallFailedEvent {
  readonly type: "model.call.failed";
  readonly error: unknown;
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
}

export type InstrumentationModelCallTerminalEvent =
  | InstrumentationModelCallCompletedEvent
  | InstrumentationModelCallFailedEvent;

export interface InstrumentationToolCallStartedEvent {
  readonly type: "tool.call.started";
  readonly callId: string;
  readonly idempotencyKey: string;
  readonly input: unknown;
  readonly kind: InstrumentationActionKind;
  readonly scope: InstrumentationAttemptScope;
  readonly toolName: string;
}

export interface InstrumentationToolCallCompletedEvent {
  readonly type: "tool.call.completed";
  readonly idempotencyKey: string;
  readonly output: InstrumentationToolOutput;
  readonly scope: InstrumentationAttemptScope;
}

export interface InstrumentationToolCallFailedEvent {
  readonly type: "tool.call.failed";
  readonly error: unknown;
  readonly idempotencyKey: string;
  readonly scope: InstrumentationAttemptScope;
}

export type InstrumentationToolCallTerminalEvent =
  | InstrumentationToolCallCompletedEvent
  | InstrumentationToolCallFailedEvent;

export interface InstrumentationHandlerContext {
  readonly state: InstrumentationStateSlot;
}

/**
 * The AI SDK can omit a model terminal when an incomplete stream closes. A
 * provider that correlates starts with terminals must scope that state to the
 * attempt and release anything still open when the step attempt terminates.
 */
export type InstrumentationEventHandler<TEvent> = (
  event: TEvent,
  ctx: InstrumentationHandlerContext,
) => void | PromiseLike<void>;

/** Internal provider shape mirrored by the future public hook contract. */
export interface InstrumentationProviderDefinition {
  readonly name: string;
  readonly events?: {
    readonly "step.attempt.started"?: InstrumentationEventHandler<InstrumentationStepAttemptStartedEvent>;
    readonly "step.attempt.completed"?: InstrumentationEventHandler<InstrumentationStepAttemptCompletedEvent>;
    readonly "step.attempt.failed"?: InstrumentationEventHandler<InstrumentationStepAttemptFailedEvent>;
    readonly "step.attempt.metadata"?: InstrumentationEventHandler<InstrumentationStepAttemptMetadataEvent>;
    readonly "model.call.started"?: InstrumentationEventHandler<InstrumentationModelCallStartedEvent>;
    readonly "model.call.completed"?: InstrumentationEventHandler<InstrumentationModelCallCompletedEvent>;
    readonly "model.call.failed"?: InstrumentationEventHandler<InstrumentationModelCallFailedEvent>;
    readonly "session.completed"?: InstrumentationEventHandler<InstrumentationSessionSettledEvent>;
    readonly "session.failed"?: InstrumentationEventHandler<InstrumentationSessionFailedEvent>;
    readonly "session.started"?: InstrumentationEventHandler<InstrumentationSessionStartedEvent>;
    readonly "session.waiting"?: InstrumentationEventHandler<InstrumentationSessionSettledEvent>;
    readonly "tool.call.started"?: InstrumentationEventHandler<InstrumentationToolCallStartedEvent>;
    readonly "tool.call.completed"?: InstrumentationEventHandler<InstrumentationToolCallCompletedEvent>;
    readonly "tool.call.failed"?: InstrumentationEventHandler<InstrumentationToolCallFailedEvent>;
    readonly "turn.cancelled"?: InstrumentationEventHandler<InstrumentationTurnSettledEvent>;
    readonly "turn.completed"?: InstrumentationEventHandler<InstrumentationTurnSettledEvent>;
    readonly "turn.failed"?: InstrumentationEventHandler<InstrumentationTurnFailedEvent>;
    readonly "turn.started"?: InstrumentationEventHandler<InstrumentationTurnStartedEvent>;
  };
  readonly flush?: () => void | PromiseLike<void>;
  readonly shutdown?: () => void | PromiseLike<void>;
}

type InstrumentationProviderInput = Omit<InstrumentationProviderDefinition, "name"> & {
  readonly name?: string;
};

/** Events that pair a start with its terminal under one `idempotencyKey`. */
export type InstrumentationCorrelatedEvent =
  | InstrumentationModelCallStartedEvent
  | InstrumentationModelCallTerminalEvent
  | InstrumentationToolCallStartedEvent
  | InstrumentationToolCallTerminalEvent;

export type InstrumentationPointEvent =
  | InstrumentationStepAttemptStartedEvent
  | InstrumentationStepAttemptMetadataEvent
  | InstrumentationStepAttemptTerminalEvent
  | InstrumentationSessionStartedEvent
  | InstrumentationSessionTransitionEvent
  | InstrumentationTurnStartedEvent
  | InstrumentationTurnTerminalEvent;

export type InstrumentationEvent = InstrumentationCorrelatedEvent | InstrumentationPointEvent;

/** Trusted framework operation for activating context around AI SDK execution. */
export type InstrumentationContextRunner = <T>(
  operation: InstrumentationExecutionOperation,
  execute: () => PromiseLike<T>,
) => PromiseLike<T>;

/** Stable identity supplied only to a trusted framework context runner. */
export type InstrumentationExecutionOperation =
  | {
      readonly idempotencyKey: string;
      readonly scope: InstrumentationAttemptScope;
      readonly type: "model.call";
    }
  | {
      readonly idempotencyKey: string;
      readonly scope: InstrumentationAttemptScope;
      readonly type: "tool.call";
    };

/** Provider-neutral hook operations consumed by the AI SDK bridge. */
export interface InstrumentationHooks {
  publish(event: InstrumentationEvent): Promise<void>;
}

const log = createLogger("harness.instrumentation-lifecycle");

/** Creates failure-isolated hooks backed by an ordered provider list. */
export function createInstrumentationHooks(
  providers: readonly InstrumentationProviderInput[],
): InstrumentationHooks {
  const publish = async (event: InstrumentationEvent): Promise<void> => {
    const terminal = isTerminal(event.type);
    const attemptTerminal =
      event.type === "step.attempt.completed" || event.type === "step.attempt.failed";
    const attemptId = stateAttemptId(event);
    for (const [providerIndex, provider] of providers.entries()) {
      const providerName = provider.name ?? `provider-${String(providerIndex)}`;
      const release = (): void => {
        if (terminal) releaseInstrumentationState(providerName, event.idempotencyKey);
        if (attemptTerminal)
          releaseInstrumentationAttemptState(providerName, event.scope.attemptId);
      };
      const handler = provider.events?.[event.type];
      if (handler === undefined) {
        release();
        continue;
      }
      const state = instrumentationStateSlot(providerName, event.idempotencyKey, attemptId);
      try {
        await (handler as InstrumentationEventHandler<InstrumentationEvent>)(event, { state });
      } catch (error) {
        log.warn("instrumentation provider failed", {
          boundary: event.type,
          error: formatError(error),
          provider: providerName,
        });
      } finally {
        state.revoke();
        release();
      }
    }
  };

  return { publish };
}

function stateAttemptId(event: InstrumentationEvent): string | undefined {
  if (!("scope" in event)) return undefined;
  return event.type.startsWith("model.call.") ||
    event.type.startsWith("tool.call.") ||
    event.type.startsWith("step.attempt.")
    ? event.scope.attemptId
    : undefined;
}

function isTerminal(type: InstrumentationEvent["type"]): boolean {
  return type.endsWith(".completed") || type.endsWith(".failed") || type.endsWith(".cancelled");
}
