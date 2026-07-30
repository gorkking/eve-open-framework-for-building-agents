import { beforeEach, describe, expect, it } from "vitest";

import type { ChannelAdapter } from "#channel/adapter.js";
import type {
  ChannelGateOperation,
  ChannelGateReceipt,
  DeliverHookPayload,
} from "#channel/types.js";
import { ChannelGateNamesKey, InitiatorAuthKey } from "#context/keys.js";
import {
  evaluateChannelDeliveryGatesStep,
  evaluateSessionResetGateStep,
  evaluateTurnCancelGateStep,
} from "#execution/channel-gate-steps.js";
import type { DurableSessionState } from "#execution/durable-session-store.js";
import { createTestRuntime } from "#internal/testing/app-harness.js";
import { getCompiledRuntimeAgentBundle } from "#runtime/sessions/compiled-agent-cache.js";
import { BundleKey, ChannelKey } from "#runtime/sessions/runtime-context-keys.js";

const ACTOR = {
  attributes: { role: "operator" },
  authenticator: "test",
  principalId: "actor",
  principalType: "user",
} as const;

const INITIATOR = {
  attributes: { role: "owner" },
  authenticator: "test",
  principalId: "initiator",
  principalType: "user",
} as const;

describe("target-owned channel gate integration", () => {
  const runtime = createTestRuntime({ agent: { name: "channel-gate-integration" } });
  const decisions = new Map<string, "allow" | "deny">();
  const calls: Array<{ readonly name: string; readonly input: unknown }> = [];
  const adapter: ChannelAdapter = {
    gates: {
      "input.response": async (input, _channel, ctx) => {
        await Promise.resolve();
        expect(ctx.session.auth).toEqual({ current: ACTOR, initiator: INITIATOR });
        calls.push({ input, name: "input.response" });
        return { type: decisions.get("input.response") ?? "allow" };
      },
      "session.reset": async (input) => {
        await Promise.resolve();
        calls.push({ input, name: "session.reset" });
        return { type: decisions.get("session.reset") ?? "allow" };
      },
      "session.resume": async (input) => {
        await Promise.resolve();
        calls.push({ input, name: "session.resume" });
        return { type: decisions.get("session.resume") ?? "allow" };
      },
      "turn.cancel": async (input) => {
        await Promise.resolve();
        calls.push({ input, name: "turn.cancel" });
        return { type: decisions.get("turn.cancel") ?? "allow" };
      },
    },
    kind: "channel:guarded",
    state: { revision: 1 },
  };

  beforeEach(() => {
    calls.length = 0;
    decisions.clear();
  });

  it("rehydrates current gate code and runs ordered async delivery checks", async () => {
    const receipts: ChannelGateReceipt[] = [];

    await expect(
      withAdapter(
        runtime,
        adapter,
        async () =>
          await evaluateChannelDeliveryGatesStep({
            delivery: delivery({
              inputResponses: [{ optionId: "approve", requestId: "req-1" }],
            }),
            operation: operation(["session.resume", "input.response"]),
            receiptWritable: collect(receipts),
            serializedContext: serializedContext(),
            sessionState: sessionState(),
          }),
      ),
    ).resolves.toEqual({ status: "allow" });

    expect(calls.map((call) => call.name)).toEqual(["session.resume", "input.response"]);
    expect(calls[1]?.input).toMatchObject({
      requests: [expect.objectContaining({ requestId: "req-1" })],
      responses: [{ optionId: "approve", requestId: "req-1" }],
      type: "answer",
    });
    expect(receipts).toEqual([]);
  });

  it.each(["session.resume", "input.response"] as const)(
    "blocks delivery when the async %s database policy denies",
    async (name) => {
      decisions.set(name, "deny");
      const receipts: ChannelGateReceipt[] = [];

      await expect(
        withAdapter(
          runtime,
          adapter,
          async () =>
            await evaluateChannelDeliveryGatesStep({
              delivery: delivery({
                inputResponses: [{ optionId: "approve", requestId: "req-1" }],
              }),
              operation: operation(["session.resume", "input.response"]),
              receiptWritable: collect(receipts),
              serializedContext: serializedContext(),
              sessionState: sessionState(),
            }),
        ),
      ).resolves.toEqual({ status: "block" });

      expect(receipts).toEqual([expect.objectContaining({ gate: name, status: "denied" })]);
    },
  );

  it.each([
    ["turn.cancel", "turn-7"],
    ["session.reset", "start over"],
  ] as const)("runs %s inside the target session against live state", async (name, detail) => {
    const common = {
      operation: operation([name]),
      receiptWritable: collect([]),
      serializedContext: serializedContext(),
      sessionState: sessionState(),
    };

    const result = await withAdapter(runtime, adapter, async () =>
      name === "turn.cancel"
        ? await evaluateTurnCancelGateStep({
            ...common,
            available: true,
            continuationToken: "guarded:thread-1",
            turnId: detail,
          })
        : await evaluateSessionResetGateStep({
            ...common,
            continuationToken: "guarded:thread-1",
            reason: detail,
          }),
    );

    expect(result).toEqual({ status: "allow" });
    expect(calls).toEqual([
      {
        input: name === "turn.cancel" ? { turnId: detail } : { reason: detail },
        name,
      },
    ]);
  });
});

function operation(names: ChannelGateOperation["names"]): ChannelGateOperation {
  return {
    adapterKind: "channel:guarded",
    auth: ACTOR,
    id: "operation-1",
    names,
  };
}

function delivery(payload: DeliverHookPayload["payloads"][number]): DeliverHookPayload {
  return {
    auth: ACTOR,
    kind: "deliver",
    payloads: [payload],
  };
}

function serializedContext(): Record<string, unknown> {
  return {
    [BundleKey.name]: { source: { kind: "bundled" } },
    [ChannelKey.name]: {
      kind: "channel:guarded",
      state: { revision: 9 },
    },
    [ChannelGateNamesKey.name]: [
      "session.resume",
      "input.response",
      "turn.cancel",
      "session.reset",
    ],
    [InitiatorAuthKey.name]: INITIATOR,
  };
}

function sessionState(): DurableSessionState {
  const request = {
    action: {
      callId: "call-1",
      input: {},
      kind: "tool-call" as const,
      toolName: "deploy",
    },
    allowFreeform: false,
    display: "confirmation" as const,
    kind: "tool-approval" as const,
    options: [
      { id: "approve", label: "Approve" },
      { id: "deny", label: "Deny" },
    ],
    prompt: "Approve deployment?",
    requestId: "req-1",
  };
  return {
    continuationToken: "guarded:thread-1",
    emissionState: {
      sequence: 7,
      sessionStarted: true,
      stepIndex: 2,
      turnId: "turn-7",
    },
    hasProxyInputRequests: false,
    sessionId: "session-1",
    snapshot: {
      session: {
        agent: { system: "" },
        continuationToken: "guarded:thread-1",
        history: [],
        sessionId: "session-1",
        state: {
          "eve.runtime.pendingInputBatch": {
            requests: [request],
            responseMessages: [],
          },
        },
      },
      version: 1,
    },
    version: 1,
  };
}

function collect(receipts: ChannelGateReceipt[]): WritableStream<ChannelGateReceipt> {
  return new WritableStream({
    write(receipt) {
      receipts.push(receipt);
    },
  });
}

async function withAdapter<T>(
  runtime: ReturnType<typeof createTestRuntime>,
  adapter: ChannelAdapter,
  callback: () => Promise<T>,
): Promise<T> {
  return await runtime.run(async () => {
    const bundle = await getCompiledRuntimeAgentBundle({
      compiledArtifactsSource: { kind: "bundled" },
    });
    (bundle.adapterRegistry.adaptersByKind as Map<string, ChannelAdapter>).set(
      adapter.kind,
      adapter,
    );
    return await callback();
  });
}
