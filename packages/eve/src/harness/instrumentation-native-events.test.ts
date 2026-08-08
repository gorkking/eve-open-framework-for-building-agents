import { describe, expect, it } from "vitest";

import { ContextContainer, contextStorage } from "#context/container.js";
import { deserializeContext, serializeContext } from "#context/serialize.js";
import {
  createActionResultEvent,
  createActionsRequestedEvent,
  createSessionStartedEvent,
  createSessionWaitingEvent,
  createStepCompletedEvent,
  createStepStartedEvent,
  createTurnCompletedEvent,
  createTurnStartedEvent,
} from "#protocol/message.js";
import { createInstrumentationHandleEvent } from "#harness/instrumentation-native-events.js";
import type { InstrumentationHooks } from "#harness/instrumentation-lifecycle.js";
import {
  actionIdempotencyKey,
  sessionIdempotencyKey,
  turnIdempotencyKey,
} from "#harness/instrumentation-lifecycle.js";

describe("createInstrumentationHandleEvent", () => {
  it("publishes native lifecycle transitions after durable handling", async () => {
    const order: string[] = [];
    const hooks: InstrumentationHooks = {
      capturesContent: false,
      publish: async (event) => {
        order.push(`lifecycle:${event.type}`);
      },
    };
    const handleEvent = createInstrumentationHandleEvent({
      agentName: "weather",
      handleEvent: async (event) => {
        order.push(`durable:${event.type}`);
      },
      hooks,
      sessionId: "session-1",
    })!;

    await handleEvent(createSessionStartedEvent());
    await handleEvent(createTurnStartedEvent({ sequence: 0, turnId: "turn-1" }));
    await handleEvent(createStepStartedEvent({ sequence: 0, stepIndex: 0, turnId: "turn-1" }));
    await handleEvent(
      createStepCompletedEvent({
        finishReason: "stop",
        sequence: 0,
        stepIndex: 0,
        turnId: "turn-1",
      }),
    );
    await handleEvent(createTurnCompletedEvent({ sequence: 0, turnId: "turn-1" }));
    await handleEvent(createSessionWaitingEvent());

    expect(order).toEqual([
      "durable:session.started",
      "lifecycle:session.started",
      "durable:turn.started",
      "lifecycle:turn.started",
      "durable:step.started",
      "durable:step.completed",
      "durable:turn.completed",
      "lifecycle:turn.completed",
      "durable:session.waiting",
      "lifecycle:session.waiting",
    ]);
  });

  it("does not change execution mode when hooks have no durable handler", () => {
    expect(
      createInstrumentationHandleEvent({
        hooks: {
          capturesContent: false,
          publish: async () => {},
        },
        sessionId: "session-1",
      }),
    ).toBeUndefined();
  });

  it("uses the restored turn id when a continuation step emits a session transition", async () => {
    const events: unknown[] = [];
    const handleEvent = createInstrumentationHandleEvent({
      handleEvent: async () => {},
      hooks: {
        capturesContent: false,
        publish: async (event) => {
          events.push(event);
        },
      },
      sessionId: "session-1",
      turnId: "turn-1",
    })!;

    await handleEvent(createSessionWaitingEvent());

    expect(events).toEqual([
      {
        idempotencyKey: sessionIdempotencyKey("session-1"),
        sessionId: "session-1",
        turnId: "turn-1",
        type: "session.waiting",
      },
    ]);
  });

  it("carries the dispatch lineage onto every turn a child session starts", async () => {
    const events: { readonly type: string }[] = [];
    const parentLineage = {
      callId: "call-7",
      sessionId: "session-1",
      subagentName: "researcher",
      turnId: "turn-1",
    };
    const handleEvent = createInstrumentationHandleEvent({
      handleEvent: async () => {},
      hooks: {
        capturesContent: false,
        publish: async (event) => {
          events.push(event);
        },
      },
      parentLineage,
      rootSessionId: "session-1",
      sessionId: "child-1",
    })!;

    await handleEvent(createTurnStartedEvent({ sequence: 0, turnId: "child-turn-1" }));
    await handleEvent(createTurnStartedEvent({ sequence: 1, turnId: "child-turn-2" }));

    expect(events.filter((event) => event.type === "turn.started")).toEqual([
      {
        idempotencyKey: turnIdempotencyKey("child-1", "child-turn-1"),
        parentLineage,
        parentTraceContext: undefined,
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "child-1",
        turnId: "child-turn-1",
        type: "turn.started",
      },
      {
        idempotencyKey: turnIdempotencyKey("child-1", "child-turn-2"),
        parentLineage,
        parentTraceContext: undefined,
        rootSessionId: "session-1",
        sequence: 1,
        sessionId: "child-1",
        turnId: "child-turn-2",
        type: "turn.started",
      },
    ]);
  });

  it("publishes every runtime action and settles it in a replacement worker", async () => {
    const events: unknown[] = [];
    const scope = {
      attemptId: "session-1:turn-1:0:0",
      attemptIndex: 0,
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    };
    const context = new ContextContainer();
    const requested = createActionsRequestedEvent({
      actions: [
        {
          callId: "delegate-1",
          description: "Delegate work.",
          input: { task: "research" },
          kind: "subagent-call",
          name: "delegate",
          nodeId: "workers",
          subagentName: "worker",
        },
        { callId: "skill-1", input: { name: "research" }, kind: "load-skill" },
        {
          callId: "remote-1",
          description: "Call a remote agent.",
          input: { task: "analyze" },
          kind: "remote-agent-call",
          name: "remote",
          nodeId: "remote-agents",
          remoteAgentName: "analyst",
        },
        { callId: "add-1", input: { a: 1, b: 2 }, kind: "tool-call", toolName: "add" },
      ],
      sequence: 0,
      stepIndex: 0,
      turnId: "turn-1",
    });

    await contextStorage.run(context, async () => {
      const handleEvent = createInstrumentationHandleEvent({
        getAttemptScope: () => scope,
        handleEvent: async () => {},
        hooks: { capturesContent: true, publish: async (event) => void events.push(event) },
        sessionId: "session-1",
      })!;
      await handleEvent(requested);
      await handleEvent(requested);
    });

    const restored = await deserializeContext(await serializeContext(context));
    await contextStorage.run(restored, async () => {
      const handleEvent = createInstrumentationHandleEvent({
        handleEvent: async () => {},
        hooks: { capturesContent: true, publish: async (event) => void events.push(event) },
        sessionId: "session-1",
      })!;
      await handleEvent(
        createActionResultEvent({
          result: {
            callId: "delegate-1",
            kind: "subagent-result",
            origin: "dispatch",
            output: "unavailable",
            isError: true,
            subagentName: "worker",
          },
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-2",
        }),
      );
      await handleEvent(
        createActionResultEvent({
          result: {
            callId: "add-1",
            kind: "tool-result",
            output: 3,
            toolName: "add",
          },
          sequence: 0,
          stepIndex: 0,
          turnId: "turn-2",
        }),
      );
    });

    expect(events.slice(0, 4)).toEqual([
      {
        callId: "delegate-1",
        idempotencyKey: actionIdempotencyKey("session-1", "turn-1", "delegate-1"),
        input: { task: "research" },
        kind: "subagent-call",
        name: "delegate",
        scope,
        type: "action.started",
      },
      {
        callId: "skill-1",
        idempotencyKey: actionIdempotencyKey("session-1", "turn-1", "skill-1"),
        input: { name: "research" },
        kind: "load-skill",
        name: "load_skill",
        scope,
        type: "action.started",
      },
      {
        callId: "remote-1",
        idempotencyKey: actionIdempotencyKey("session-1", "turn-1", "remote-1"),
        input: { task: "analyze" },
        kind: "remote-agent-call",
        name: "remote",
        scope,
        type: "action.started",
      },
      {
        callId: "add-1",
        idempotencyKey: actionIdempotencyKey("session-1", "turn-1", "add-1"),
        input: { a: 1, b: 2 },
        kind: "tool-call",
        name: "add",
        scope,
        type: "action.started",
      },
    ]);
    expect(events[4]).toMatchObject({
      idempotencyKey: actionIdempotencyKey("session-1", "turn-1", "delegate-1"),
      scope,
      type: "action.failed",
    });
    expect(events[5]).toEqual({
      idempotencyKey: actionIdempotencyKey("session-1", "turn-1", "add-1"),
      output: { output: 3, type: "result" },
      scope,
      type: "action.completed",
    });
    expect(events).toHaveLength(6);
    expect(events.every(Object.isFrozen)).toBe(true);
  });
});
