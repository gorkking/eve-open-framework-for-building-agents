import { describe, expect, it } from "vitest";

import { createTestRuntime } from "#internal/testing/app-harness.js";
import { createBundledRuntimeCompiledArtifactsSource } from "#runtime/compiled-artifacts-source.js";
import { DynamicToolCallOriginsKey, type DurableDynamicToolMetadata } from "#context/keys.js";
import { createDurableSessionState } from "#execution/durable-session-store.js";
import { settleCancelledTurnStep } from "#execution/settle-cancelled-turn-step.js";
import {
  createDynamicToolOriginState,
  recordDynamicToolCallOrigin,
  type DurableDynamicToolOriginState,
} from "#harness/dynamic-tool-call-origins.js";
import { setHarnessEmissionState } from "#harness/emission.js";
import { deriveAgentOperationId } from "#harness/handles/operation-id.js";
import {
  AGENT_HANDLES_STATE_KEY,
  deriveAgentId,
  getAgentHandleStore,
  type AgentHandle,
} from "#harness/handles/store.js";
import { appendPendingInputBatch } from "#harness/input-requests.js";
import type { HarnessSession } from "#harness/types.js";

/**
 * The cancellation epilogue is the last write that can move a cancelled
 * child's handle: `cancelDescendantTurnsStep` only requests cancellation,
 * and the turn inbox a child settlement would resume is torn down with the
 * cancelled turn. These tests pin the persisted handle store the epilogue
 * leaves behind — a `running` handle surviving here would be permanent.
 */

const PARENT_SESSION_ID = "parent-session-cancel-handles";
const CONTINUATION_TOKEN = "http:settle-cancel-handles";

const RUNNING_OPERATION_ID = deriveAgentOperationId({
  callId: "call-1",
  parentSessionId: PARENT_SESSION_ID,
  parentTurnId: "turn-1",
});

const RUNNING_HANDLE: AgentHandle = {
  address: {
    continuationToken: "subagent:child-running",
    kind: "agent/local",
    sessionId: "child-session-running",
  },
  identity: {
    id: deriveAgentId("research", RUNNING_OPERATION_ID),
    name: "research",
    nodeId: "subagents/research",
  },
  operation: {
    callId: "call-1",
    id: RUNNING_OPERATION_ID,
    kind: "start",
    parentTurnId: "turn-1",
  },
  phase: "running",
};

const PARKED_OPERATION_ID = deriveAgentOperationId({
  callId: "call-0",
  parentSessionId: PARENT_SESSION_ID,
  parentTurnId: "turn-0",
});

const PARKED_HANDLE: AgentHandle = {
  address: {
    continuationToken: "subagent:child-parked",
    kind: "agent/local",
    sessionId: "child-session-parked",
  },
  identity: {
    id: deriveAgentId("writer", PARKED_OPERATION_ID),
    name: "writer",
    nodeId: "subagents/writer",
  },
  lastStatus: "draft ready",
  phase: "parked",
};

function createCancelledTurnSession(handles: readonly AgentHandle[]): HarnessSession {
  return setHarnessEmissionState(
    {
      agent: { modelReference: { id: "openai/gpt-5.4" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 100_000 },
      continuationToken: CONTINUATION_TOKEN,
      history: [],
      sessionId: PARENT_SESSION_ID,
      state: { [AGENT_HANDLES_STATE_KEY]: { handles } },
    },
    { sequence: 3, sessionStarted: true, stepIndex: 1, turnId: "turn-1" },
  );
}

function buildSerializedContext(origins?: DurableDynamicToolOriginState): Record<string, unknown> {
  const serialized: Record<string, unknown> = {
    "eve.auth": null,
    "eve.bundle": { source: createBundledRuntimeCompiledArtifactsSource() },
    "eve.channel": { kind: "http", state: {} },
    "eve.continuationToken": CONTINUATION_TOKEN,
    "eve.mode": "conversation",
    "eve.sessionId": PARENT_SESSION_ID,
  };
  if (origins !== undefined) serialized[DynamicToolCallOriginsKey.name] = origins;
  return serialized;
}

function dynamicDefinition(definitionId: string): DurableDynamicToolMetadata {
  return {
    callbacks: {
      execute: { closure: { definitionId }, stepId: `execute-${definitionId}` },
    },
    definitionId,
    description: `Definition ${definitionId}`,
    entryKey: "update",
    event: "turn.started",
    inputSchema: { type: "object" },
    name: "update",
    ownerId: "updates",
    resolverSlug: "updates",
    runtimeRevision: "deployment:test",
    sourceId: "agent/tools/update.ts",
  };
}

function originState(): DurableDynamicToolOriginState {
  let state = recordDynamicToolCallOrigin(
    createDynamicToolOriginState(),
    dynamicDefinition("definition-old"),
    {
      callId: "call-old",
      originatingStepIndex: 0,
      originatingTurnId: "turn-0",
      toolName: "update",
    },
  );
  state = recordDynamicToolCallOrigin(state, dynamicDefinition("definition-current"), {
    callId: "call-current",
    originatingStepIndex: 1,
    originatingTurnId: "turn-1",
    toolName: "update",
  });
  return state;
}

function sessionWithPendingOlderCall(): HarnessSession {
  return appendPendingInputBatch({
    requests: [
      {
        action: {
          callId: "call-old",
          input: {},
          kind: "tool-call",
          toolName: "update",
        },
        allowFreeform: false,
        display: "confirmation",
        kind: "tool-approval",
        options: [
          { id: "approve", label: "Approve" },
          { id: "cancel", label: "Cancel" },
        ],
        prompt: "Approve older call",
        requestId: "approval-old",
      },
    ],
    responseMessages: [],
    session: createCancelledTurnSession([]),
  });
}

describe("settleCancelledTurnStep handle store", () => {
  it("parks abandoned running handles as cancelled and keeps parked ones", async () => {
    const runtime = createTestRuntime({ agent: { name: "settle-cancel-handles" } });

    await runtime.run(async () => {
      const result = await settleCancelledTurnStep({
        parentWritable: new WritableStream<Uint8Array>({ write() {} }),
        serializedContext: buildSerializedContext(),
        sessionState: createDurableSessionState({
          session: createCancelledTurnSession([RUNNING_HANDLE, PARKED_HANDLE]),
        }),
      });

      expect(getAgentHandleStore(result.sessionState.snapshot?.session.state)).toEqual({
        handles: [
          {
            address: RUNNING_HANDLE.address,
            identity: RUNNING_HANDLE.identity,
            lastStatus: "(cancelled)",
            phase: "parked",
          },
          PARKED_HANDLE,
        ],
      });
    });
  });

  it("releases only origins owned by the cancelled turn", async () => {
    const runtime = createTestRuntime({ agent: { name: "settle-cancel-origins" } });

    await runtime.run(async () => {
      const result = await settleCancelledTurnStep({
        parentWritable: new WritableStream<Uint8Array>({ write() {} }),
        serializedContext: buildSerializedContext(originState()),
        sessionState: createDurableSessionState({ session: sessionWithPendingOlderCall() }),
      });

      expect(result.serializedContext[DynamicToolCallOriginsKey.name]).toMatchObject({
        calls: {
          "call-old": {
            definitionId: "definition-old",
            originatingTurnId: "turn-0",
          },
        },
        definitions: {
          "definition-old": { definitionId: "definition-old" },
        },
        version: 1,
      });
    });
  });
});
