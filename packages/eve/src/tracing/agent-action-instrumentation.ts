import {
  ROOT_CONTEXT,
  SpanStatusCode,
  type Context,
  type Span,
  type SpanContext,
  type Tracer,
  trace,
} from "#compiled/@opentelemetry/api/index.js";

import type {
  InstrumentationActionStartedEvent,
  InstrumentationActionTerminalEvent,
  InstrumentationProviderDefinition,
} from "#harness/instrumentation-lifecycle.js";
import { actionIdempotencyKey } from "#harness/instrumentation-lifecycle.js";
import { contentAttribute } from "#tracing/agent-otel-content.js";
import type { AgentSpanIdGenerator } from "#tracing/agent-span-id-generator.js";
import type { AgentActionTraceState, AgentTraceStateStore } from "#tracing/agent-trace-state.js";

export interface AgentActionInstrumentation {
  readonly events: Pick<
    NonNullable<InstrumentationProviderDefinition["events"]>,
    "action.completed" | "action.failed" | "action.started"
  >;
  deleteForSession(sessionId: string): void | PromiseLike<void>;
  deleteForTurn(sessionId: string, turnId: string): void | PromiseLike<void>;
  contextFor(sessionId: string, turnId: string, callId: string): Promise<Context | undefined>;
}

/** Builds durable `agent.action` spans around eve's runtime dispatch boundary. */
export function createAgentActionInstrumentation(input: {
  readonly frameworkVersion: string;
  readonly idGenerator: AgentSpanIdGenerator;
  readonly recordInputs: boolean;
  readonly recordOutputs: boolean;
  readonly resolveParent: (
    event: InstrumentationActionStartedEvent,
  ) => { readonly context: Context; readonly spanContext: SpanContext } | undefined;
  readonly stateStore: AgentTraceStateStore;
  readonly tracer: Tracer;
}): AgentActionInstrumentation {
  const onStarted = async (event: InstrumentationActionStartedEvent): Promise<void> => {
    const parent = input.resolveParent(event);
    if (parent === undefined) return;

    const existing = await input.stateStore.getAction(event.idempotencyKey);
    const state: AgentActionTraceState = existing ?? {
      attemptIndex: event.scope.attemptIndex,
      callId: event.callId,
      inputAttribute: input.recordInputs ? contentAttribute(event.input, false) : undefined,
      kind: event.kind,
      name: event.name,
      parent: {
        spanId: parent.spanContext.spanId,
        traceFlags: parent.spanContext.traceFlags,
        traceId: parent.spanContext.traceId,
      },
      rootSessionId: event.scope.rootSessionId ?? event.scope.sessionId,
      sessionId: event.scope.sessionId,
      spanId: input.idGenerator.allocateSpanId(),
      startTimeMs: Date.now(),
      stepIndex: event.scope.stepIndex,
      turnId: event.scope.turnId,
    };
    await input.stateStore.setAction(event.idempotencyKey, state);
  };

  const onTerminal = async (event: InstrumentationActionTerminalEvent): Promise<void> => {
    const state = await input.stateStore.getAction(event.idempotencyKey);
    if (state === undefined) return;
    try {
      const span = startSpan(state);
      if (event.type === "action.failed") {
        recordError(span, event.error);
      } else if (event.output.type === "error") {
        recordError(span, event.output.error);
      } else if (input.recordOutputs) {
        const result = contentAttribute(event.output.output, false);
        if (result !== undefined) span.setAttribute("gen_ai.tool.call.result", result);
      }
      span.end();
    } finally {
      await input.stateStore.deleteAction(event.idempotencyKey);
    }
  };

  const startSpan = (state: AgentActionTraceState): Span => {
    const span = input.idGenerator.withSpanId(state.spanId, () =>
      input.tracer.startSpan(
        "agent.action",
        {
          attributes: {
            "agent.action.call_id": state.callId,
            "agent.action.kind": state.kind,
            "agent.action.name": state.name,
            "agent.framework.name": "eve",
            "agent.framework.version": input.frameworkVersion,
            "agent.root.session.id": state.rootSessionId,
            "agent.session.id": state.sessionId,
            "agent.step.attempt": state.attemptIndex,
            "agent.step.index": state.stepIndex,
            "agent.turn.id": state.turnId,
          },
          startTime: state.startTimeMs,
        },
        contextFromActionState(state),
      ),
    );
    if (state.inputAttribute !== undefined) {
      span.setAttribute("gen_ai.tool.call.arguments", state.inputAttribute);
    }
    return span;
  };

  return {
    async contextFor(sessionId, turnId, callId) {
      const directKey = actionIdempotencyKey(sessionId, turnId, callId);
      const direct = await input.stateStore.getAction(directKey);
      if (direct !== undefined) return actionContext(direct);
      const state = await input.stateStore.findAction(sessionId, callId);
      return state === undefined ? undefined : actionContext(state);
    },
    deleteForSession: (sessionId) => input.stateStore.deleteActions(sessionId),
    deleteForTurn: (sessionId, turnId) => input.stateStore.deleteActions(sessionId, turnId),
    events: {
      "action.completed": onTerminal,
      "action.failed": onTerminal,
      "action.started": onStarted,
    },
  };
}

function actionContext(state: AgentActionTraceState): Context {
  return trace.setSpan(
    ROOT_CONTEXT,
    trace.wrapSpanContext({
      isRemote: false,
      spanId: state.spanId,
      traceFlags: state.parent.traceFlags,
      traceId: state.parent.traceId,
    }),
  );
}

function contextFromActionState(state: AgentActionTraceState): Context {
  return trace.setSpan(ROOT_CONTEXT, trace.wrapSpanContext({ ...state.parent, isRemote: false }));
}

function recordError(span: Span, error: unknown): void {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
  } else span.setStatus({ code: SpanStatusCode.ERROR });
}
