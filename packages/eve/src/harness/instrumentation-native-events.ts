import type { UnstampedMessageStreamEvent } from "#protocol/message.js";
import type {
  InstrumentationAttemptScope,
  InstrumentationHooks,
  InstrumentationParentLineage,
  InstrumentationPointEvent,
  InstrumentationToolCallStartedEvent,
  InstrumentationTraceContext,
} from "#harness/instrumentation-lifecycle.js";
import type { HandleEventFn, HarnessToolMap } from "#harness/types.js";

export interface InstrumentationActionSource {
  readonly scope: InstrumentationAttemptScope;
  readonly tools: HarnessToolMap;
}

export interface CreateInstrumentationHandleEventInput {
  readonly agentName?: string;
  readonly getActionSource?: () => InstrumentationActionSource | undefined;
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
      await publishDelegationActions(event, input, hooks, publishedActions);
    }
  };
}

async function publishDelegationActions(
  event: Extract<UnstampedMessageStreamEvent, { type: "actions.requested" }>,
  input: CreateInstrumentationHandleEventInput,
  hooks: InstrumentationHooks,
  published: Set<string>,
): Promise<void> {
  const source = input.getActionSource?.();
  if (source === undefined) return;

  for (const action of event.data.actions) {
    if (action.kind !== "subagent-call" && action.kind !== "remote-agent-call") continue;
    const tool = source.tools.get(action.name);
    if (tool?.runtimeAction === undefined || tool.execute !== undefined) continue;
    const deduplicationKey = `${source.scope.attemptId}:${action.callId}`;
    if (published.has(deduplicationKey)) continue;
    published.add(deduplicationKey);
    await hooks.publish(
      Object.freeze({
        callId: action.callId,
        id: `${source.scope.attemptId}:tool:${action.callId}:0`,
        input: action.input,
        kind: tool.runtimeAction.kind,
        scope: source.scope,
        toolName: tool.name,
        type: "tool.call.started",
      } satisfies InstrumentationToolCallStartedEvent),
    );
  }
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
        parentTraceContext: input.parentTraceContext,
        rootSessionId: input.rootSessionId ?? input.sessionId,
        sessionId: input.sessionId,
        type: "session.started",
      };
    case "session.completed":
    case "session.waiting":
      return { sessionId: input.sessionId, turnId: activeTurnId, type: event.type };
    case "session.failed":
      return {
        error: new Error(event.data.message),
        sessionId: input.sessionId,
        turnId: activeTurnId,
        type: "session.failed",
      };
    case "turn.started":
      return {
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
      return { sessionId: input.sessionId, turnId: event.data.turnId, type: event.type };
    case "turn.failed":
      return {
        error: new Error(event.data.message),
        sessionId: input.sessionId,
        turnId: event.data.turnId,
        type: "turn.failed",
      };
    default:
      return undefined;
  }
}
