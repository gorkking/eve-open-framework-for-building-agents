import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import {
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

describe("createInstrumentationHandleEvent", () => {
  it("publishes native lifecycle transitions after durable handling", async () => {
    const order: string[] = [];
    const hooks: InstrumentationHooks = {
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
        publish: async (event) => {
          events.push(event);
        },
      },
      sessionId: "session-1",
      turnId: "turn-1",
    })!;

    await handleEvent(createSessionWaitingEvent());

    expect(events).toEqual([{ sessionId: "session-1", turnId: "turn-1", type: "session.waiting" }]);
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
        parentLineage,
        parentTraceContext: undefined,
        rootSessionId: "session-1",
        sequence: 0,
        sessionId: "child-1",
        turnId: "child-turn-1",
        type: "turn.started",
      },
      {
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

  it("publishes each non-executable delegation once from actions.requested", async () => {
    const events: unknown[] = [];
    const scope = {
      attemptId: "session-1:turn-1:0:0",
      attemptIndex: 0,
      sessionId: "session-1",
      stepIndex: 0,
      turnId: "turn-1",
    };
    const tools = new Map([
      [
        "delegate",
        {
          description: "Delegate work.",
          inputSchema: jsonSchema({ type: "object" }),
          name: "delegate",
          runtimeAction: {
            kind: "subagent-call" as const,
            nodeId: "workers",
            subagentName: "worker",
          },
        },
      ],
      [
        "add",
        {
          description: "Add numbers.",
          execute: () => 3,
          inputSchema: jsonSchema({ type: "object" }),
          name: "add",
        },
      ],
      [
        "remote",
        {
          description: "Call a remote agent.",
          inputSchema: jsonSchema({ type: "object" }),
          name: "remote",
          runtimeAction: {
            kind: "remote-agent-call" as const,
            nodeId: "remote-agents",
            remoteAgentName: "analyst",
            subagentName: "analyst",
          },
        },
      ],
    ]);
    const handleEvent = createInstrumentationHandleEvent({
      getActionSource: () => ({ scope, tools }),
      handleEvent: async () => {},
      hooks: { publish: async (event) => void events.push(event) },
      sessionId: "session-1",
    })!;
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

    await handleEvent(requested);
    await handleEvent(requested);

    expect(events).toEqual([
      {
        callId: "delegate-1",
        id: "session-1:turn-1:0:0:tool:delegate-1:0",
        input: { task: "research" },
        kind: "subagent-call",
        scope,
        toolName: "delegate",
        type: "tool.call.started",
      },
      {
        callId: "remote-1",
        id: "session-1:turn-1:0:0:tool:remote-1:0",
        input: { task: "analyze" },
        kind: "remote-agent-call",
        scope,
        toolName: "remote",
        type: "tool.call.started",
      },
    ]);
    expect(Object.isFrozen(events[0])).toBe(true);
    expect(Object.isFrozen(events[1])).toBe(true);
  });
});
