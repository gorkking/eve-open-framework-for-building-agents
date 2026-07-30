import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type { ChannelGateReceipt, DeliverHookPayload } from "#channel/types.js";
import { ContextContainer } from "#context/container.js";
import {
  ChannelGateNamesKey,
  ContinuationTokenKey,
  InitiatorAuthKey,
  SessionIdKey,
} from "#context/keys.js";
import {
  evaluateChannelDeliveryGatesStep,
  evaluateSessionResetGateStep,
  evaluateTurnCancelGateStep,
  publishChannelGateAllowStep,
  publishChannelGateReadyStep,
  resolveInputResponseGateInput,
} from "#execution/channel-gate-steps.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { ChannelKey } from "#runtime/sessions/runtime-context-keys.js";
import type { InputRequest } from "#runtime/input/types.js";

const mocks = vi.hoisted(() => ({
  deserializeContext: vi.fn(),
  readDurableSession: vi.fn(),
}));

vi.mock("#context/serialize.js", () => ({
  deserializeContext: (...args: unknown[]) => mocks.deserializeContext(...args),
}));

vi.mock("#execution/durable-session-store.js", async (importOriginal) => ({
  ...(await importOriginal()),
  readDurableSession: (...args: unknown[]) => mocks.readDurableSession(...args),
}));

const ACTOR = {
  attributes: {},
  authenticator: "test",
  principalId: "actor",
  principalType: "user",
};

const INITIATOR = {
  attributes: {},
  authenticator: "test",
  principalId: "initiator",
  principalType: "user",
};

const APPROVAL: InputRequest = {
  action: { callId: "call-1", input: {}, kind: "tool-call", toolName: "bash" },
  allowFreeform: false,
  display: "confirmation",
  kind: "tool-approval",
  options: [
    { id: "approve", label: "Approve" },
    { id: "deny", label: "Deny" },
  ],
  prompt: "Approve bash?",
  requestId: "req-1",
};

const SESSION_STATE: DurableSessionState = {
  continuationToken: "slack:C1:T1",
  emissionState: { sequence: 3, sessionStarted: true, stepIndex: 2, turnId: "turn-3" },
  hasProxyInputRequests: false,
  sessionId: "session-1",
  version: 1,
};

describe("target-owned channel gate steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readDurableSession.mockResolvedValue({
      agent: { system: "" },
      continuationToken: "slack:C1:T1",
      history: [],
      sessionId: "session-1",
      state: {
        "eve.runtime.pendingInputBatch": {
          requests: [APPROVAL],
          responseMessages: [],
        },
      },
    });
  });

  it("publishes an immutable versioned readiness declaration before gated operations", async () => {
    mocks.deserializeContext.mockResolvedValue(
      createContext({
        gates: { "session.resume": () => ({ type: "allow" }) },
        kind: "channel:slack",
      }),
    );
    const declarations: unknown[] = [];

    await publishChannelGateReadyStep({
      serializedContext: serializedContext(["session.resume"]),
      writable: new WritableStream({
        write(value) {
          declarations.push(value);
        },
      }),
    });

    expect(declarations).toEqual([
      {
        adapterKind: "channel:slack",
        names: ["session.resume"],
        version: 1,
      },
    ]);
  });

  it("evaluates resume before response with live actor, initiator, and pending requests", async () => {
    const calls: string[] = [];
    const adapter: ChannelAdapter = {
      gates: {
        "input.response": (input, channel, ctx) => {
          calls.push("input.response");
          expect(input).toMatchObject({
            requests: [APPROVAL],
            responses: [{ optionId: "approve", requestId: "req-1" }],
            source: "text",
            type: "answer",
          });
          expect(channel.session.continuationToken).toBe("slack:C1:T1");
          expect(ctx.session.auth).toEqual({ current: ACTOR, initiator: INITIATOR });
          return { type: "allow" };
        },
        "session.resume": () => {
          calls.push("session.resume");
          return { type: "allow" };
        },
      },
      kind: "channel:slack",
      state: { mutable: "original" },
    };
    mocks.deserializeContext.mockResolvedValue(createContext(adapter));
    const receipts: ChannelGateReceipt[] = [];

    const result = await evaluateChannelDeliveryGatesStep({
      delivery: delivery("Approve"),
      operation: operation(["session.resume", "input.response"]),
      receiptWritable: receiptWritable(receipts),
      serializedContext: serializedContext(["session.resume", "input.response"]),
      sessionState: SESSION_STATE,
    });

    expect(result).toEqual({ status: "allow" });
    expect(calls).toEqual(["session.resume", "input.response"]);
    expect(receipts).toEqual([]);
    await publishChannelGateAllowStep({
      id: "operation-1",
      writable: receiptWritable(receipts),
    });
    expect(receipts).toEqual([{ id: "operation-1", status: "allow" }]);
  });

  it("stops at the first denial and emits one private receipt", async () => {
    const responseGate = vi.fn(() => ({ type: "allow" as const }));
    mocks.deserializeContext.mockResolvedValue(
      createContext({
        gates: {
          "input.response": responseGate,
          "session.resume": () => ({ reason: "Initiator only.", type: "deny" }),
        },
        kind: "channel:slack",
      }),
    );
    const receipts: ChannelGateReceipt[] = [];

    await expect(
      evaluateChannelDeliveryGatesStep({
        delivery: delivery("Approve"),
        operation: operation(["session.resume", "input.response"]),
        receiptWritable: receiptWritable(receipts),
        serializedContext: serializedContext(["session.resume", "input.response"]),
        sessionState: SESSION_STATE,
      }),
    ).resolves.toEqual({ status: "block" });

    expect(responseGate).not.toHaveBeenCalled();
    expect(receipts).toEqual([
      {
        gate: "session.resume",
        id: "operation-1",
        reason: "Initiator only.",
        status: "denied",
      },
    ]);
  });

  it("fails closed when the target session did not declare the requested gate", async () => {
    mocks.deserializeContext.mockResolvedValue(
      createContext({
        gates: { "session.resume": () => ({ type: "allow" }) },
        kind: "channel:slack",
      }),
    );
    const receipts: ChannelGateReceipt[] = [];

    await expect(
      evaluateChannelDeliveryGatesStep({
        delivery: delivery("continue"),
        operation: operation(["session.resume"]),
        receiptWritable: receiptWritable(receipts),
        serializedContext: serializedContext([]),
        sessionState: SESSION_STATE,
      }),
    ).resolves.toEqual({ status: "block" });

    expect(receipts[0]).toMatchObject({
      gate: "session.resume",
      id: "operation-1",
      status: "unavailable",
    });
  });

  it("rejects cancellation and reset when the observed continuation is no longer owned", async () => {
    mocks.deserializeContext.mockResolvedValue(
      createContext({
        gates: {
          "session.reset": () => ({ type: "allow" }),
          "turn.cancel": () => ({ type: "allow" }),
        },
        kind: "channel:slack",
      }),
    );
    const receipts: ChannelGateReceipt[] = [];
    const common = {
      operation: operation(["turn.cancel"]),
      receiptWritable: receiptWritable(receipts),
      serializedContext: serializedContext(["turn.cancel", "session.reset"]),
      sessionState: SESSION_STATE,
    };

    await evaluateTurnCancelGateStep({
      ...common,
      available: true,
      continuationToken: "slack:replacement",
    });
    await evaluateSessionResetGateStep({
      ...common,
      continuationToken: "slack:replacement",
      operation: operation(["session.reset"]),
    });

    expect(receipts).toEqual([
      { id: "operation-1", status: "no_active_session" },
      { id: "operation-1", status: "no_active_session" },
    ]);
  });
});

describe("resolveInputResponseGateInput", () => {
  it("recognizes explicit, option-label, freeform, and dismiss resolutions", () => {
    expect(
      resolveInputResponseGateInput(
        { inputResponses: [{ optionId: "approve", requestId: "req-1" }] },
        [APPROVAL],
      ),
    ).toMatchObject({ source: "explicit", type: "answer" });
    expect(resolveInputResponseGateInput({ message: "Approve" }, [APPROVAL])).toMatchObject({
      source: "text",
      type: "answer",
    });

    const freeform = {
      ...APPROVAL,
      allowFreeform: true,
      kind: "question" as const,
      options: undefined,
    };
    expect(resolveInputResponseGateInput({ message: "Alice" }, [freeform])).toMatchObject({
      responses: [{ requestId: "req-1", text: "Alice" }],
      source: "text",
      type: "answer",
    });

    const dismissable = {
      ...APPROVAL,
      kind: "question" as const,
    };
    expect(resolveInputResponseGateInput({ message: "Never mind" }, [dismissable])).toMatchObject({
      source: "message",
      type: "dismiss",
    });
  });
});

function createContext(adapter: ChannelAdapter): ContextContainer {
  const ctx = new ContextContainer();
  ctx.set(ChannelKey, adapter);
  ctx.set(ContinuationTokenKey, "slack:stale");
  ctx.set(InitiatorAuthKey, INITIATOR);
  ctx.set(SessionIdKey, "session-1");
  return ctx;
}

function serializedContext(names: readonly string[]): Record<string, unknown> {
  return { [ChannelGateNamesKey.name]: names };
}

function operation(
  names: readonly ("input.response" | "session.resume" | "turn.cancel" | "session.reset")[],
) {
  return {
    adapterKind: "channel:slack",
    auth: ACTOR,
    id: "operation-1",
    names,
  } as const;
}

function delivery(message: string): DeliverHookPayload {
  return {
    auth: ACTOR,
    kind: "deliver",
    payloads: [{ message }],
  };
}

function receiptWritable(receipts: ChannelGateReceipt[]): WritableStream<ChannelGateReceipt> {
  return new WritableStream({
    write(receipt) {
      receipts.push(receipt);
    },
  });
}
