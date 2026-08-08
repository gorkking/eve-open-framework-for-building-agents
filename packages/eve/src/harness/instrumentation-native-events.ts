import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type {
  InstrumentationActionFailedEvent,
  InstrumentationActionStartedEvent,
  InstrumentationAttemptScope,
  InstrumentationHooks,
  InstrumentationParentLineage,
  InstrumentationPointEvent,
  InstrumentationTraceContext,
} from "#harness/instrumentation-lifecycle.js";
import {
  actionIdempotencyKey,
  sessionIdempotencyKey,
  turnIdempotencyKey,
} from "#harness/instrumentation-lifecycle.js";
import {
  rememberInstrumentationActionScope,
  takeInstrumentationActionScopeForCall,
} from "#harness/instrumentation-state.js";
import type { HandleEventFn } from "#harness/types.js";
import type { RuntimeActionRequest } from "#runtime/actions/types.js";

export interface CreateInstrumentationHandleEventInput {
  readonly agentName?: string;
  readonly getAttemptScope?: () => InstrumentationAttemptScope | undefined;
  readonly handleEvent?: HandleEventFn;
  readonly hooks?: InstrumentationHooks;
  readonly parentLineage?: InstrumentationParentLineage;
  readonly parentTraceContext?: InstrumentationTraceContext;
  readonly rootSessionId?: string;
  readonly sessionId: string;
  readonly turnId?: string;
}

/** Publishes eve-native lifecycle transitions after durable event acceptance. */
export function createInstrumentationHandleEvent(
  input: CreateInstrumentationHandleEventInput,
): HandleEventFn | undefined {
  if (input.hooks === undefined) return input.handleEvent;
  if (input.handleEvent === undefined) return undefined;

  const handleEvent = input.handleEvent;
  const hooks = input.hooks;
  const publishedActions = new Set<string>();
  let activeTurnId = input.turnId;
  return async (event, messages) => {
    await handleEvent(event, messages);
    const lifecycleEvent = toLifecycleEvent(event, input, activeTurnId);
    if (event.type === "turn.started") activeTurnId = event.data.turnId;
    if (lifecycleEvent !== undefined) await hooks.publish(lifecycleEvent);
    if (event.type === "actions.requested") {
      await publishActionStarts(event, input, hooks, publishedActions);
    } else if (event.type === "action.result") {
      await publishActionTerminal(event, input, hooks);
    }
  };
}

async function publishActionStarts(
  event: Extract<UnstampedMessageStreamEvent, { type: "actions.requested" }>,
  input: CreateInstrumentationHandleEventInput,
  hooks: InstrumentationHooks,
  published: Set<string>,
): Promise<void> {
  const scope = input.getAttemptScope?.();
  if (scope === undefined) return;

  for (const action of event.data.actions) {
    const idempotencyKey = actionIdempotencyKey(input.sessionId, event.data.turnId, action.callId);
    if (published.has(idempotencyKey)) continue;
    published.add(idempotencyKey);
    rememberInstrumentationActionScope(idempotencyKey, scope);
    await hooks.publish(
      Object.freeze({
        callId: action.callId,
        idempotencyKey,
        input: action.input,
        kind: action.kind,
        name: actionName(action),
        scope,
        type: "action.started",
      } satisfies InstrumentationActionStartedEvent),
    );
  }
}

async function publishActionTerminal(
  event: Extract<UnstampedMessageStreamEvent, { type: "action.result" }>,
  input: CreateInstrumentationHandleEventInput,
  hooks: InstrumentationHooks,
): Promise<void> {
  const correlation = takeInstrumentationActionScopeForCall(
    input.sessionId,
    event.data.result.callId,
  );
  if (correlation === undefined) return;
  const { idempotencyKey, scope } = correlation;

  if (event.data.status === "completed") {
    await hooks.publish(
      Object.freeze({
        idempotencyKey,
        output: Object.freeze({ output: event.data.result.output, type: "result" }),
        scope,
        type: "action.completed",
      }),
    );
    return;
  }

  const error =
    event.data.error === undefined
      ? event.data.result.output
      : Object.assign(new Error(event.data.error.message), { code: event.data.error.code });
  await hooks.publish(
    Object.freeze({
      error,
      idempotencyKey,
      scope,
      type: "action.failed",
    } satisfies InstrumentationActionFailedEvent),
  );
}

function actionName(action: RuntimeActionRequest): string {
  if (action.kind === "tool-call") return action.toolName;
  if (action.kind === "load-skill") return "load_skill";
  return action.name;
}

function toLifecycleEvent(
  event: UnstampedMessageStreamEvent,
  input: CreateInstrumentationHandleEventInput,
  activeTurnId: string | undefined,
): InstrumentationPointEvent | undefined {
  switch (event.type) {
    case "session.started":
      return {
        agentName: input.agentName,
        idempotencyKey: sessionIdempotencyKey(input.sessionId),
        parentTraceContext: input.parentTraceContext,
        rootSessionId: input.rootSessionId ?? input.sessionId,
        sessionId: input.sessionId,
        type: "session.started",
      };
    case "session.completed":
    case "session.waiting":
      return {
        idempotencyKey: sessionIdempotencyKey(input.sessionId),
        sessionId: input.sessionId,
        turnId: activeTurnId,
        type: event.type,
      };
    case "session.failed":
      return {
        error: new Error(event.data.message),
        idempotencyKey: sessionIdempotencyKey(input.sessionId),
        sessionId: input.sessionId,
        turnId: activeTurnId,
        type: "session.failed",
      };
    case "turn.started":
      return {
        idempotencyKey: turnIdempotencyKey(input.sessionId, event.data.turnId),
        parentLineage: input.parentLineage,
        parentTraceContext: input.parentTraceContext,
        rootSessionId: input.rootSessionId ?? input.sessionId,
        sequence: event.data.sequence,
        sessionId: input.sessionId,
        turnId: event.data.turnId,
        type: "turn.started",
      };
    case "turn.completed":
    case "turn.cancelled":
      return {
        idempotencyKey: turnIdempotencyKey(input.sessionId, event.data.turnId),
        sessionId: input.sessionId,
        turnId: event.data.turnId,
        type: event.type,
      };
    case "turn.failed":
      return {
        error: new Error(event.data.message),
        idempotencyKey: turnIdempotencyKey(input.sessionId, event.data.turnId),
        sessionId: input.sessionId,
        turnId: event.data.turnId,
        type: "turn.failed",
      };
    default:
      return undefined;
  }
}
