import { describe, expect, it, vi } from "vitest";

import type { SessionAuthContext } from "#channel/types.js";
import { replayDynamicTools } from "#context/build-dynamic-tools.js";
import { ContextContainer, contextStorage } from "#context/container.js";
import {
  DynamicToolCallOriginsKey,
  SessionKey,
  type DurableDynamicToolMetadata,
} from "#context/keys.js";
import { settleDirectApprovalResponse } from "#harness/approval-candidates.js";
import { coordinateApprovalDelivery } from "#harness/approval-delivery-coordinator.js";
import { appendPendingInputBatch } from "#harness/pending-input-batches.js";
import type { HarnessSession } from "#harness/types.js";
import type { InputRequest } from "#runtime/input/types.js";
import {
  createDynamicToolOriginState,
  recordDynamicToolCallOrigin,
} from "#harness/dynamic-tool-call-origins.js";

const request: InputRequest = {
  action: { callId: "call-1", input: { marker: "durable" }, kind: "tool-call", toolName: "gate" },
  allowFreeform: false,
  display: "confirmation",
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Approve" },
    { id: "cancel", label: "Cancel" },
  ],
  prompt: "Approve tool call: gate",
  requestId: "approval-1",
};
const responder: SessionAuthContext = {
  attributes: {},
  authenticator: "test",
  issuer: "test",
  principalId: "user-1",
  principalType: "user",
};

function parkedSession(): HarnessSession {
  return appendPendingInputBatch({
    requests: [request],
    responseAuthRequiredRequestIds: [request.requestId],
    responseMessages: [],
    session: {
      agent: { modelReference: { id: "test" }, system: "", tools: [] },
      compaction: { recentWindowSize: 10, threshold: 0.8 },
      continuationToken: "test",
      history: [],
      sessionId: "session-1",
    },
  });
}

describe("coordinateApprovalDelivery", () => {
  it("recovers an allowed settlement before its synthetic response is consumed", async () => {
    const parked = parkedSession();
    const settled = settleDirectApprovalResponse({
      actor: responder,
      outcome: "allowed",
      requestId: request.requestId,
      settledAt: 100,
      state: parked.state,
    });
    const result = await coordinateApprovalDelivery({
      now: 101,
      session: { ...parked, state: settled.state },
      tools: new Map(),
    });
    expect(result.kind).toBe("continue");
    expect(result.stepInput?.inputResponses).toEqual([
      { optionId: "approve", requestId: request.requestId },
    ]);
  });

  it("recovers a cancelled settlement before its synthetic response is consumed", async () => {
    const parked = parkedSession();
    const settled = settleDirectApprovalResponse({
      actor: responder,
      outcome: "cancelled",
      requestId: request.requestId,
      settledAt: 100,
      state: parked.state,
    });
    const result = await coordinateApprovalDelivery({
      now: 101,
      session: { ...parked, state: settled.state },
      tools: new Map(),
    });
    expect(result.kind).toBe("continue");
    expect(result.stepInput?.inputResponses).toEqual([
      { optionId: "cancel", requestId: request.requestId },
    ]);
  });

  it("routes response authorization through the originating dynamic definition", async () => {
    const responseA = vi.fn(() => ({ status: "allowed" as const }));
    const responseB = vi.fn(() => ({ status: "rejected" as const }));
    const a = dynamicDefinition("definition-a", responseA);
    const b = dynamicDefinition("definition-b", responseB);
    const ctx = new ContextContainer();
    ctx.set(SessionKey, {
      auth: { current: responder, initiator: responder },
      sessionId: "session-1",
      turn: { id: "turn-b", sequence: 1 },
    });
    ctx.set(
      DynamicToolCallOriginsKey,
      recordDynamicToolCallOrigin(createDynamicToolOriginState(), a, {
        callId: request.action.callId,
        originatingStepIndex: 0,
        originatingTurnId: "turn-a",
        toolName: request.action.toolName,
      }),
    );
    const tools = new Map([[request.action.toolName, replayDynamicTools([b])[0]!]]);

    const candidate = await contextStorage.run(ctx, () =>
      coordinateApprovalDelivery({
        now: 100,
        session: parkedSession(),
        stepInput: {
          attributedInputResponses: [
            {
              auth: responder,
              response: { optionId: "approve", requestId: request.requestId },
            },
          ],
        },
        tools,
      }),
    );
    expect(candidate.kind).toBe("continue-coordination");

    const allowed = await contextStorage.run(ctx, () =>
      coordinateApprovalDelivery({ now: 101, session: candidate.session, tools }),
    );

    expect(allowed.kind).toBe("continue");
    expect(allowed.stepInput?.inputResponses).toEqual([
      { optionId: "approve", requestId: request.requestId },
    ]);
    expect(responseA).toHaveBeenCalledOnce();
    expect(responseB).not.toHaveBeenCalled();
  });
});

function dynamicDefinition(
  definitionId: string,
  response: () => { readonly status: "allowed" | "rejected" },
): DurableDynamicToolMetadata {
  const registryKey = Symbol.for("@workflow/core//registeredSteps");
  const global = globalThis as Record<symbol, Map<string, Function> | undefined>;
  const registry = global[registryKey] ?? new Map<string, Function>();
  global[registryKey] = registry;
  registry.set(`execute-${definitionId}`, () => null);
  registry.set(`request-${definitionId}`, () => "user-approval");
  registry.set(`response-${definitionId}`, response);
  return {
    callbacks: {
      approvalRequest: { closure: {}, stepId: `request-${definitionId}` },
      approvalResponse: { closure: {}, stepId: `response-${definitionId}` },
      execute: { closure: {}, stepId: `execute-${definitionId}` },
    },
    definitionId,
    description: definitionId,
    entryKey: "gate",
    event: "turn.started",
    inputSchema: { type: "object" },
    name: "gate",
    ownerId: "gate",
    resolverSlug: "gate",
    runtimeRevision: definitionId,
    sourceId: "agent/tools/gate.ts",
  };
}
